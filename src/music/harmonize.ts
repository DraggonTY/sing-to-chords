import { chordById, chordPalette, pitchClass, rankChords, type Chord, type KeySignature, type RawNote } from './theory.ts'

export type HarmonySlot = {
  id: string
  startBeat: number
  durationBeats: number
  chord: Chord
  options: Chord[]
  edited: boolean
}

type WindowNote = RawNote & { attackBeat: number }
type HarmonyWindow = {
  id: string
  startBeat: number
  durationBeats: number
  notes: WindowNote[]
  candidates: Chord[]
  locked: Chord | null
  scores: number[]
}

/**
 * Max-sum sequence decoding balances each window's melody fit with its neighbours.
 * The weights are tonal-pop heuristics, not a trained model or a probability.
 * Edits are fixed states during decoding so later choices respond to the user's chord.
 */
export function harmonizeMelody(
  notes: RawNote[],
  key: KeySignature,
  edits: Record<string, string>,
  span: 1 | 2 | 4,
): HarmonySlot[] {
  const valid = notes.filter((note) => Number.isFinite(note.midi) && Number.isFinite(note.startBeat)
    && Number.isFinite(note.durationBeats) && note.durationBeats > 0 && note.startBeat + note.durationBeats > 0)
    .sort((a, b) => a.startBeat - b.startBeat)
  if (!valid.length) return []
  const end = valid.reduce((latest, note) => Math.max(latest, note.startBeat + note.durationBeats), 0)
  const palette = chordPalette(key)
  const windows: HarmonyWindow[] = []
  // Only visit occupied windows: a long rest should not allocate thousands of states.
  const occupied = new Set<number>()
  for (const note of valid) {
    const first = Math.floor(Math.max(0, note.startBeat) / span)
    const last = Math.ceil((note.startBeat + note.durationBeats) / span) - 1
    for (let index = first; index <= last; index++) occupied.add(index)
  }

  for (const index of [...occupied].sort((a, b) => a - b)) {
    const start = index * span
    const stop = Math.min(start + span, end)
    const inside = valid.flatMap((note): WindowNote[] => {
      const overlapStart = Math.max(start, note.startBeat)
      const overlapEnd = Math.min(stop, note.startBeat + note.durationBeats)
      if (overlapEnd <= overlapStart + 1e-8) return []
      return [{ ...note, attackBeat: note.startBeat, startBeat: overlapStart, durationBeats: overlapEnd - overlapStart }]
    })
    if (!inside.length) continue
    const candidates = new Map(palette.map((chord) => [chord.id, chord]))
    // Borrowed chords are considered only when a substantial chromatic note needs one.
    for (const note of inside) {
      const pc = pitchClass(Math.round(note.midi))
      if (note.durationBeats < 0.35 || palette.some((chord) => chord.tones.includes(pc))) continue
      for (const chord of rankChords(Math.round(note.midi), key, null).slice(0, 3)) candidates.set(chord.id, chord)
    }
    const id = `${span}@${start}`
    const locked = chordById(edits[id] ?? '')
    if (locked) candidates.set(locked.id, locked)
    windows.push({ id, startBeat: start, durationBeats: stop - start, notes: inside, candidates: [...candidates.values()], locked, scores: [] })
  }
  if (!windows.length) return []

  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]
    window.scores = window.candidates.map((chord) => melodyScore(chord, window, key, index === 0, index === windows.length - 1))
  }

  const forward: number[][] = []
  const parents: number[][] = []
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]
    forward.push(new Array<number>(window.candidates.length).fill(-Infinity))
    parents.push(new Array<number>(window.candidates.length).fill(-1))
    window.candidates.forEach((chord, candidate) => {
      if (window.locked && chord.id !== window.locked.id) return
      if (!index) {
        forward[index][candidate] = window.scores[candidate]
        return
      }
      const previous = windows[index - 1]
      previous.candidates.forEach((prior, priorIndex) => {
        const score = forward[index - 1][priorIndex] + window.scores[candidate]
          + connection(prior, chord, previous, window, key)
        if (score > forward[index][candidate]) {
          forward[index][candidate] = score
          parents[index][candidate] = priorIndex
        }
      })
    })
  }

  const selected = new Array<number>(windows.length)
  const lastScores = forward[forward.length - 1]
  selected[selected.length - 1] = lastScores.indexOf(Math.max(...lastScores))
  for (let index = selected.length - 1; index > 0; index--) selected[index - 1] = parents[index][selected[index]]

  return windows.map((window, index) => {
    const chosen = window.candidates[selected[index]]
    const previous = windows[index - 1]
    const next = windows[index + 1]
    // Alternative choices are ranked in the context of the audible progression.
    const alternatives = window.candidates.map((chord, candidate) => ({
      chord,
      score: window.scores[candidate]
        + (previous ? connection(previous.candidates[selected[index - 1]], chord, previous, window, key) : 0)
        + (next ? connection(chord, next.candidates[selected[index + 1]], window, next, key) : 0),
    })).sort((a, b) => b.score - a.score)
    const options = [chosen, ...alternatives.filter(({ chord }) => chord.id !== chosen.id).slice(0, 7).map(({ chord }) => chord)]
    return { id: window.id, startBeat: window.startBeat, durationBeats: window.durationBeats, chord: chosen, options, edited: Boolean(window.locked) }
  })
}

function melodyScore(chord: Chord, window: HarmonyWindow, key: KeySignature, first: boolean, last: boolean): number {
  let hit = 0
  let miss = 0
  let clash = 0
  for (const note of window.notes) {
    const pc = pitchClass(Math.round(note.midi))
    const onBeat = Math.abs(note.attackBeat - Math.round(note.attackBeat)) < 0.12
    const strongAttack = Math.abs(note.attackBeat - window.startBeat) < 0.12
    // Duration is clipped to THIS window. Short offbeat passing tones count less.
    const passing = note.durationBeats < 0.75 && !onBeat
    const weight = note.durationBeats * (passing ? 0.55 : 1) * (strongAttack ? 1.3 : onBeat ? 1.12 : 1)
    if (chord.tones.includes(pc)) hit += weight
    else {
      miss += weight
      if (!passing && chord.tones.some((tone) => pitchClass(pc - tone) === 1 || pitchClass(tone - pc) === 1)) clash += weight
    }
  }
  const total = hit + miss
  const degree = pitchClass(chord.root - key.tonic)
  const tonic = degree === 0 && chord.quality === (key.mode === 'major' ? 'maj' : 'min')
  // Melody agreement dominates the small chord-function and transition priors.
  let score = (6 * hit - 2 * miss - 0.6 * clash) / Math.max(total, 1e-8)
  if (tonic) score += 0.36
  else if (degree === 5 || degree === 7) score += 0.24
  else if (degree === 2 || degree === 9 || (key.mode === 'minor' && degree === 8)) score += 0.06
  if (chord.quality === 'dim' || chord.quality === 'aug') score -= 0.45
  if (chord.tones.length > 3) score -= 0.8
  if (first && tonic) score += 0.3
  const ending = window.notes.reduce((latest, note) => note.startBeat + note.durationBeats > latest.startBeat + latest.durationBeats ? note : latest)
  if (last && tonic && pitchClass(Math.round(ending.midi)) === key.tonic) score += 0.85
  return score
}

function connection(previous: Chord, current: Chord, left: HarmonyWindow, right: HarmonyWindow, key: KeySignature): number {
  // Separate phrases do not force a cadence across a silent window.
  if (right.startBeat > left.startBeat + left.durationBeats + 1e-6) return 0
  if (previous.id === current.id) return 0.26
  const from = pitchClass(previous.root - key.tonic)
  const to = pitchClass(current.root - key.tonic)
  const rootMotion = pitchClass(current.root - previous.root)
  let score = -0.16
  // Common tones and short pitch-class motion favor a coherent accompaniment.
  const common = previous.tones.filter((tone) => current.tones.includes(tone)).length
  score += common * 0.1
  if (rootMotion === 5) score += 0.32
  else if (rootMotion === 7) score += 0.14
  if ((from === 2 || from === 5) && to === 7) score += 0.2
  if ((from === 7 || from === 11) && to === 0) score += 0.42
  if (from === 5 && to === 0) score += 0.14
  if (previous.quality === 'dim' && to !== 0 && rootMotion !== 1 && rootMotion !== 2) score -= 0.25
  return score
}
