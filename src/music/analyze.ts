import { keyFromMelody, type Chord, type KeySignature, type RawNote } from './theory.ts'
import { harmonizeMelody } from './harmonize.ts'
import { extractSingingNotes } from './pitch.ts'

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
}

// Live transcription and the synchronous API deliberately share the same engine.
export function analyzeRecording(samples: Float32Array, sampleRate: number, bpm: number): Analysis {
  return analysisFromNotes(extractSingingNotes(samples, sampleRate, bpm))
}

export function analyzeNoteList(notes: RawNote[]): Analysis {
  return analysisFromNotes(notes)
}

export function analysisFromNotes(input: RawNote[]): Analysis {
  const notes = cleanNotes(input)
  const detected = keyFromMelody(notes.map((note) => ({ pitch: note.midi, weight: note.durationBeats })))
  return { ...detected, notes }
}

export function layoutChords(
  notes: RawNote[],
  key: KeySignature,
  edits: Record<string, string>,
  span: ChordSpan,
): ChordSlot[] {
  return harmonizeMelody(cleanNotes(notes), key, edits, span)
}

export function applyQuantize(input: RawNote[], division: QuantizeDivision): RawNote[] {
  const notes = cleanNotes(input)
  if (division === 'off') return notes
  const grid = division === '8' ? 0.5 : 0.25
  const starts = notes.map((note) => Math.round(note.startBeat / grid) * grid)

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
    const originalEnd = note.startBeat + note.durationBeats
    const snappedEnd = Math.round(originalEnd / grid) * grid
    let end = Math.max(startBeat + grid, snappedEnd)
    const nextStart = starts[index + 1]
    if (nextStart != null && nextStart > startBeat) end = Math.min(end, nextStart)
    return { ...note, startBeat, durationBeats: end - startBeat }
  })
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
