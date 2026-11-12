import { keyFromMelody, pitchClass, type Chord, type KeySignature, type RawNote } from './theory.ts'
import { harmonizeMelody } from './harmonize.ts'
import { extractSingingNotes } from './pitch.ts'
import { findBeat, notesOnBeat } from './tempo.ts'

export type QuantizeDivision = 'off' | '8' | '16'
export type ChordSpan = 1 | 2 | 4

export type ChordSlot = {
  id: string
  startBeat: number
  durationBeats: number
  chord: Chord
  options: Chord[]
  edited: boolean
}

export type Analysis = {
  key: KeySignature
  confidence: number
  notes: RawNote[]
  /** Set when the tempo was found from the singing instead of a click. */
  bpm?: number
  beatConfidence?: number
  /** Which pitch tracker produced the notes. */
  engine?: 'neural' | 'built-in'
  /** Why the neural tracker was not used, for diagnosis. */
  engineError?: string
}

// Live transcription and the synchronous API deliberately share the same engine.
export function analyzeRecording(samples: Float32Array, sampleRate: number, bpm: number): Analysis {
  return analysisFromNotes(extractSingingNotes(samples, sampleRate, bpm))
}

/**
 * Free singing: no click and no tempo given. Transcribe in seconds, find the
 * singer's own pulse, and place the notes on it.
 */
export function analyzeFreely(samples: Float32Array, sampleRate: number): Analysis {
  return analysisOnFoundBeat(extractSingingNotes(samples, sampleRate, 60))
}

/** As analyzeFreely, for notes already transcribed in seconds (that is, at 60 BPM). */
export function analysisOnFoundBeat(inSeconds: RawNote[]): Analysis {
  const map = findBeat(inSeconds.map((note) => ({ start: note.startBeat, end: note.startBeat + note.durationBeats })))
  // Too little to find a pulse: keep seconds as beats (60 BPM) so nothing is lost.
  if (!map) return { ...analysisFromNotes(inSeconds), bpm: 60, beatConfidence: 0 }
  return { ...analysisFromNotes(notesOnBeat(inSeconds, map)), bpm: Math.round(map.bpm * 10) / 10, beatConfidence: map.confidence }
}

export function analyzeNoteList(notes: RawNote[]): Analysis {
  return analysisFromNotes(notes)
}

export function analysisFromNotes(input: RawNote[]): Analysis {
  const tuned = retune(cleanNotes(input))
  // Where phrases come to rest: before a breath of most of a beat, and at the end.
  const rests = tuned.filter((note, index) => {
    const next = tuned[index + 1]
    return !next || next.startBeat - (note.startBeat + note.durationBeats) >= 0.75
  }).map((note) => note.midi)
  const heard = keyFromMelody(tuned.map((note) => ({ pitch: note.midi, weight: note.durationBeats })), rests)
  const settled = settleInKey(tuned, heard.key)
  return plainerKey({ ...heard, notes: settled })
}

// Sharps or flats in each major key's signature, by tonic.
const SIGNATURE = [0, 5, 2, 3, 4, 1, 6, 1, 4, 3, 2, 5]
const accidentals = (key: KeySignature) => SIGNATURE[(key.tonic + (key.mode === 'minor' ? 3 : 0)) % 12]

/**
 * Someone singing alone has no reference pitch, so a tune often lands between
 * two keys: a third of a semitone under E flat minor is as much D minor, sung
 * sharp. When the voice sits that far from the piano's tuning, name the tune in
 * whichever neighbouring key has the plainer signature and the easier chords.
 */
function plainerKey(analysis: Analysis): Analysis {
  const sung = analysis.notes.filter((note) => note.sungPitch !== undefined && Number.isFinite(note.sungPitch))
  if (sung.length < 4) return analysis
  let x = 0
  let y = 0
  let weight = 0
  for (const note of sung) {
    const w = Math.min(2, note.durationBeats)
    x += w * Math.cos(2 * Math.PI * (note.sungPitch! - note.midi))
    y += w * Math.sin(2 * Math.PI * (note.sungPitch! - note.midi))
    weight += w
  }
  if (Math.hypot(x, y) / weight < 0.3) return analysis
  const offset = Math.atan2(y, x) / (2 * Math.PI)
  if (Math.abs(offset) < 0.25) return analysis
  const step = offset < 0 ? -1 : 1
  const neighbour: KeySignature = { tonic: (analysis.key.tonic + step + 12) % 12, mode: analysis.key.mode }
  if (accidentals(neighbour) >= accidentals(analysis.key)) return analysis
  if (analysis.notes.some((note) => note.midi + step < 0 || note.midi + step > 127)) return analysis
  return { ...analysis, key: neighbour, notes: analysis.notes.map((note) => ({ ...note, midi: note.midi + step })) }
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10, 11]

/**
 * Name each sung note relative to where THIS singer's notes sit, not A440.
 * Someone singing 40 cents sharp throughout is singing the tune in tune with
 * themselves; rounding each note separately scatters it across two keys.
 * The reference follows the singer as it drifts during the take.
 */
function retune(notes: RawNote[]): RawNote[] {
  const sung = notes.filter((note) => note.sungPitch !== undefined && Number.isFinite(note.sungPitch))
  if (sung.length < 4) return notes
  // Offsets from the semitone grid live on a circle: 49 cents sharp and 49 cents
  // flat are neighbours. Take the whole take's offset first, then let each
  // note's neighbourhood drift around it. Measuring each neighbourhood on its
  // own lets a singer near the half-way point flip between "sharp" and "flat"
  // from note to note, which names the same sung pitch as two different keys.
  const circular = (weightOf: (other: RawNote) => number) => {
    let x = 0
    let y = 0
    let weight = 0
    for (const other of sung) {
      const w = weightOf(other)
      x += w * Math.cos(2 * Math.PI * other.sungPitch!)
      y += w * Math.sin(2 * Math.PI * other.sungPitch!)
      weight += w
    }
    return { offset: Math.atan2(y, x) / (2 * Math.PI), strength: Math.hypot(x, y) / weight }
  }
  const whole = circular((other) => Math.min(2, other.durationBeats))
  if (whole.strength < 0.3) return notes
  return notes.map((note) => {
    if (note.sungPitch === undefined || !Number.isFinite(note.sungPitch)) return note
    const near = circular((other) => {
      const distance = (other.startBeat - note.startBeat) / 24
      return Math.min(2, other.durationBeats) * (0.25 + Math.exp(-distance * distance))
    })
    // The local offset, expressed as a small departure from the whole take's.
    const drift = near.strength < 0.3 ? 0 : near.offset - whole.offset - Math.round(near.offset - whole.offset)
    const midi = Math.round(note.sungPitch - (whole.offset + drift))
    return midi === note.midi || midi < 0 || midi > 127 ? note : { ...note, midi }
  })
}

/**
 * A note sung nearly halfway between two keys has no reliable name by itself.
 * When exactly one of the two is in the detected key, that is the likely intent.
 */
function settleInKey(notes: RawNote[], key: KeySignature): RawNote[] {
  const sung = notes.filter((note) => note.sungPitch !== undefined)
  if (sung.length < 6) return notes
  const scale = key.mode === 'major' ? MAJOR : MINOR
  const inKey = (midi: number) => scale.includes(pitchClass(midi - key.tonic))
  // Only trust the key when the tune already sits in it.
  const fitting = sung.reduce((sum, note) => sum + (inKey(note.midi) ? note.durationBeats : 0), 0)
  const total = sung.reduce((sum, note) => sum + note.durationBeats, 0)
  if (fitting / total < 0.8) return notes
  // The singer's offset from the grid, measured on the notes that fit.
  let x = 0
  let y = 0
  for (const note of sung) {
    if (!inKey(note.midi)) continue
    x += note.durationBeats * Math.cos(2 * Math.PI * (note.sungPitch! - note.midi))
    y += note.durationBeats * Math.sin(2 * Math.PI * (note.sungPitch! - note.midi))
  }
  const offset = Math.atan2(y, x) / (2 * Math.PI)
  return notes.map((note) => {
    if (note.sungPitch === undefined || inKey(note.midi)) return note
    const error = note.sungPitch - offset - note.midi
    if (Math.abs(error) < 0.22) return note // sung squarely on a chromatic note
    const neighbour = note.midi + Math.sign(error)
    return inKey(neighbour) && neighbour >= 0 && neighbour <= 127 ? { ...note, midi: neighbour } : note
  })
}

export function layoutChords(
  notes: RawNote[],
  key: KeySignature,
  edits: Record<string, string>,
  span: ChordSpan,
  rich = false,
): ChordSlot[] {
  return harmonizeMelody(cleanNotes(notes), key, edits, span, rich)
}

export function applyQuantize(input: RawNote[], division: QuantizeDivision): RawNote[] {
  const notes = cleanNotes(input)
  if (division === 'off') return notes
  const grid = division === '8' ? 0.5 : 0.25
  const late = entryLag(notes, grid)
  const starts = notes.map((note) => Math.max(0, Math.round((note.startBeat - late) / grid)) * grid)

  // Colliding ornaments retain their original onsets. Do not reverse pitch
  // order, drop a note, or shift the rest of the phrase to make room.
  for (let first = 0; first < notes.length;) {
    let after = first + 1
    while (after < notes.length && starts[after] === starts[first]) after++
    if (after - first > 1) {
      for (let index = first; index < after; index++) starts[index] = notes[index].startBeat
    }
    first = after
  }

  return notes.map((note, index) => {
    const startBeat = starts[index]
    const originalEnd = note.startBeat + note.durationBeats - late
    const snappedEnd = Math.round(originalEnd / grid) * grid
    let end = Math.max(startBeat + grid, snappedEnd)
    const nextStart = starts[index + 1]
    if (nextStart != null && nextStart > startBeat) end = Math.min(end, nextStart)
    return { ...note, startBeat, durationBeats: end - startBeat }
  })
}

/**
 * Sung notes arrive consistently after the click: the microphone path adds
 * delay, and a note's pitch only starts after its consonant. Snapping each
 * onset separately then pushes the ones nearest a boundary a whole step late.
 * Measure the take's shared lag against the grid and remove it before snapping.
 */
function entryLag(notes: RawNote[], grid: number): number {
  if (notes.length < 5) return 0
  // A lag can exceed half a sixteenth, so the sixteenth grid alone cannot tell
  // "a little late" from "a little early". Tunes mostly start notes on beats
  // and half beats: score each candidate lag against the whole metre.
  const levels = [[1, 1], [0.5, 0.7], [0.25, 0.45]].filter(([step]) => step >= grid - 1e-9)
  const width = 0.07
  let best = 0
  let bestScore = -Infinity
  let zeroScore = 0
  // Up to about a third of a beat: beyond that it is syncopation, not lateness.
  for (let lag = -0.12; lag <= 0.3501; lag += 0.01) {
    let score = 0
    for (const note of notes) {
      const position = note.startBeat - lag
      let fit = 0
      for (const [step, value] of levels) {
        const distance = Math.abs(position - Math.round(position / step) * step)
        fit = Math.max(fit, value * Math.exp(-0.5 * (distance / width) ** 2))
      }
      score += fit * Math.min(1, 0.5 + note.durationBeats)
    }
    // Among near-equal fits, the smallest correction is the safest.
    score -= Math.abs(lag) * 0.02 * notes.length
    if (Math.abs(lag) < 0.005) zeroScore = score
    if (score > bestScore) { bestScore = score; best = lag }
  }
  // Leave the take alone unless the shift clearly improves how it sits.
  return bestScore > zeroScore * 1.05 + 0.2 ? best : 0
}

export function placeLabel(startBeat: number): string {
  const bar = Math.floor(startBeat / 4) + 1
  const within = ((startBeat % 4) + 4) % 4
  const quarter = Math.floor(within + 1e-6)
  const fraction = within - quarter
  const nearest = Math.round(fraction * 4) / 4
  if (Math.abs(fraction - nearest) < 0.03) {
    const suffix = ['', 'e', '&', 'a'][Math.round(fraction * 4) % 4]
    return `${bar}.${quarter + 1}${suffix}`
  }
  return `${bar} · ${(within + 1).toFixed(2)}`
}

function cleanNotes(notes: RawNote[]): RawNote[] {
  return notes
    .filter((note) => Number.isInteger(note.midi) && note.midi >= 0 && note.midi <= 127
      && Number.isFinite(note.startBeat) && note.startBeat >= 0
      && Number.isFinite(note.durationBeats) && note.durationBeats > 0)
    .map((note) => ({ ...note }))
    .sort((a, b) => a.startBeat - b.startBeat)
}
