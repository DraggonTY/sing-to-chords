import type { RawNote } from './theory.ts'

/** Beat times in seconds. `beats[0]` is a bar line at or before the first note. */
export type BeatMap = { bpm: number; confidence: number; beats: number[] }

type Timed = { start: number; weight: number }

const MIN_BPM = 56
const MAX_BPM = 176
// How closely a sung entry has to sit on a pulse to count, in seconds. A fixed
// time, not a fraction of a beat, so that a faster grid is not easier to hit.
const TOLERANCE = 0.035
const LEVELS: readonly (readonly [number, number])[] = [[1, 1], [0.5, 0.6], [0.25, 0.25]]

/**
 * Find the pulse of an unaccompanied melody from where its notes begin.
 * Notes are given in seconds. Returns null when there is too little to go on.
 *
 * 1. Score every tempo and phase by how well entries sit on beats and half
 *    beats, weighted towards a comfortable walking pace: a melody fits a grid
 *    twice as fast just as well, so fit alone cannot choose between them.
 * 2. Follow the singer from beat to beat, since nobody keeps strict time
 *    without a click.
 * 3. Choose which beat is the bar line from where the long notes start.
 */
export function findBeat(notes: { start: number; end: number }[]): BeatMap | null {
  const entries: Timed[] = notes
    .filter((note) => Number.isFinite(note.start) && Number.isFinite(note.end) && note.end > note.start)
    .map((note) => ({ start: note.start, weight: Math.min(1, 0.4 + (note.end - note.start)) }))
    .sort((a, b) => a.start - b.start)
  if (entries.length < 6) return null
  const first = entries[0].start
  const last = notes.reduce((latest, note) => Math.max(latest, note.end), 0)
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0)

  // Singers without a click speed up and slow down, so one rigid grid cannot be
  // laid over the whole take. Each tempo is lined up on the opening seconds and
  // then followed through the take; it is judged by how well it stays with the singer.
  const opening = entries.filter((entry) => entry.start <= first + 6)
  let best = { score: -Infinity, beats: [] as number[] }
  const scores: Array<{ bpm: number; score: number }> = []
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 1) {
    const period = 60 / bpm
    let phase = 0
    let phaseFit = -Infinity
    for (let step = 0; step < 24; step++) {
      const candidate = (step / 24) * period
      let fit = 0
      for (const entry of opening) fit += pulseFit((entry.start - candidate) / period, period) * entry.weight
      if (fit > phaseFit) { phaseFit = fit; phase = candidate }
    }
    const followed = followSinger(entries, period, phase, first, last)
    let fit = 0
    let onBeat = 0
    for (const entry of entries) {
      const position = positionOf(entry.start, followed)
      const local = followed[Math.min(followed.length - 1, Math.max(1, Math.ceil(position)))] - followed[Math.min(followed.length - 2, Math.max(0, Math.ceil(position) - 1))]
      fit += pulseFit(position, local) * entry.weight
      if (Math.abs(position - Math.round(position)) * local < TOLERANCE) onBeat++
    }
    // A grid most of whose beats pass with no entry is probably too fast.
    const occupancy = Math.min(1, onBeat / Math.max(1, (last - first) / period)) ** 0.5
    const preference = Math.exp(-0.5 * (Math.log2(bpm / 100) / 0.5) ** 2)
    const score = (fit / totalWeight) * occupancy * (0.35 + 0.65 * preference)
    scores.push({ bpm, score })
    if (score > best.score) best = { score, beats: followed }
  }
  const beats = best.beats
  const chosen = 60 / medianSpan(beats)
  // Only a clearly different tempo is a rival, not a neighbour that follows to the same pulse.
  const runnerUp = scores.reduce((top, entry) => Math.abs(Math.log2(entry.bpm / chosen)) > 0.15 ? Math.max(top, entry.score) : top, 0)
  const bar = barLine(notes, beats)
  const aligned = beats.slice(bar)
  const separation = runnerUp > 0 ? Math.min(1, Math.max(0, (best.score - runnerUp) / (0.25 * best.score))) : 1
  return { bpm: chosen, confidence: Math.min(0.95, best.score * (0.5 + 0.5 * separation)), beats: aligned }
}

/** How well a position (in beats) sits on the pulse: beats count most, then half beats. */
function pulseFit(position: number, period: number): number {
  let value = 0
  for (const [grid, worth] of LEVELS) {
    const distance = Math.abs(position - Math.round(position / grid) * grid) * period
    value = Math.max(value, worth * Math.exp(-0.5 * (distance / TOLERANCE) ** 2))
  }
  return value
}

function medianSpan(beats: number[]): number {
  const spans = beats.slice(1).map((time, index) => time - beats[index]).sort((a, b) => a - b)
  return spans[Math.floor(spans.length / 2)]
}

/** Step from beat to beat, letting nearby entries pull the pulse a little. */
function followSinger(entries: Timed[], period: number, phase: number, first: number, last: number): number[] {
  // Start early enough to choose a bar line before the first note.
  let time = phase + Math.floor((first - phase) / period) * period - 4 * period
  let current = period
  const beats = [time]
  let cursor = 0
  while (time < last + current) {
    const predicted = time + current
    while (cursor < entries.length && entries[cursor].start < predicted - 0.75 * current) cursor++
    let pull = 0
    let weight = 0
    for (let index = cursor; index < entries.length && entries[index].start < predicted + 0.3 * current; index++) {
      const entry = entries[index]
      const onBeat = entry.start - predicted
      const onHalf = entry.start - (predicted - current / 2)
      if (Math.abs(onBeat) < 0.2 * current) { pull += onBeat * entry.weight; weight += entry.weight }
      else if (Math.abs(onHalf) < 0.12 * current) { pull += onHalf * entry.weight * 0.5; weight += entry.weight * 0.5 }
    }
    const error = weight ? pull / weight : 0
    time = predicted + 0.55 * error
    current = Math.min(period * 1.12, Math.max(period * 0.89, current + 0.18 * error))
    beats.push(time)
  }
  return beats
}

/**
 * Which beat is "one"? Melodies usually begin on it. The common exception is a
 * pickup: a few short notes leading to a long one, which then takes the bar line.
 * (Long notes in general do not mark it: phrase endings often land on beat three.)
 */
function barLine(notes: { start: number; end: number }[], beats: number[]): number {
  const ordered = notes.slice().sort((a, b) => a.start - b.start)
  const opening = positionOf(ordered[0].start, beats)
  let bar = Math.round(opening)
  for (const note of ordered.slice(1)) {
    const position = positionOf(note.start, beats)
    if (position - opening > 3.6) break
    const length = positionOf(note.end, beats) - position
    if (length >= 2.5 && Math.abs(position - Math.round(position)) < 0.25) { bar = Math.round(position) - 4; break }
  }
  while (bar > opening + 0.25) bar -= 4
  bar = Math.max(0, bar)
  // Do not open with most of a bar of silence: keep the half-bar alignment and start nearer the voice.
  while (opening - bar >= 2) bar += 2
  return bar
}

function positionOf(time: number, beats: number[]): number {
  if (time <= beats[0]) return (time - beats[0]) / (beats[1] - beats[0])
  for (let index = 1; index < beats.length; index++) {
    if (time <= beats[index]) return index - 1 + (time - beats[index - 1]) / (beats[index] - beats[index - 1])
  }
  const final = beats.length - 1
  return final + (time - beats[final]) / (beats[final] - beats[final - 1])
}

/** Re-express notes measured in seconds (transcribed at 60 BPM) as beats on the singer's own pulse. */
export function notesOnBeat(notes: RawNote[], map: BeatMap): RawNote[] {
  return notes.map((note) => {
    const start = Math.max(0, positionOf(note.startBeat, map.beats))
    const end = positionOf(note.startBeat + note.durationBeats, map.beats)
    const startBeat = Math.round(start * 1000) / 1000
    return { ...note, startBeat, durationBeats: Math.max(0.05, Math.round((end - start) * 1000) / 1000) }
  })
}
