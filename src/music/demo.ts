import type { RawNote } from './theory.ts'

const tune: Array<[number, number, number]> = [
  [60, 0, 1],
  [60, 1, 1],
  [67, 2, 1],
  [67, 3, 1],
  [69, 4, 1],
  [69, 5, 1],
  [67, 6, 2],
  [65, 8, 1],
  [65, 9, 1],
  [64, 10, 1],
  [64, 11, 1],
  [62, 12, 1],
  [62, 13, 1],
  [60, 14, 2],
]

export const sampleWords = [
  'Twin',
  'kle',
  'twin',
  'kle',
  'lit',
  'tle',
  'star',
  'How',
  'I',
  'won',
  'der',
  'what',
  'you',
  'are',
]

export const sampleTune: RawNote[] = tune.map(([midi, startBeat, durationBeats], index) => ({
  id: `sample-${index}`,
  midi,
  startBeat,
  durationBeats,
}))
