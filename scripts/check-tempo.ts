import assert from 'node:assert/strict'
import { sampleTune } from '../src/music/demo.ts'
import { findBeat, notesOnBeat } from '../src/music/tempo.ts'
import type { RawNote } from '../src/music/theory.ts'

// The sample tune "sung" at a given tempo, in seconds, starting after a breath,
// with uneven entries and (optionally) a tempo that speeds up through the take.
const jitter = [0.02, -0.03, 0.01, 0.025, -0.02, 0.03, -0.01, 0.015, -0.025, 0.02, 0, -0.015, 0.03, -0.02]
function sung(bpm: number, lead: number, rush = 0, tune: RawNote[] = sampleTune): RawNote[] {
  const time = (beat: number) => lead + (beat * 60 / bpm) * (1 - rush * beat / 32)
  return tune.map((note, index) => {
    const start = time(note.startBeat) + jitter[index % jitter.length]
    return { ...note, id: `n${index}`, startBeat: start, durationBeats: time(note.startBeat + note.durationBeats) - start - 0.08 }
  })
}
const spans = (notes: RawNote[]) => notes.map((note) => ({ start: note.startBeat, end: note.startBeat + note.durationBeats }))

for (const bpm of [66, 84, 100, 118, 140]) {
  for (const rush of [0, 0.08]) {
    const take = sung(bpm, 0.7, rush)
    const map = findBeat(spans(take))!
    const mean = bpm / (1 - rush * 8 / 32)
    assert.ok(Math.abs(map.bpm / mean - 1) < 0.07, `tempo ${bpm} rush ${rush}: found ${map.bpm.toFixed(1)}`)
    const placed = notesOnBeat(take, map).map((note) => Math.round(note.startBeat * 2) / 2)
    assert.deepEqual(placed, sampleTune.map((note) => note.startBeat), `tempo ${bpm} rush ${rush}: every note on its beat, bar line on the first note`)
    for (let index = 1; index < map.beats.length; index++) assert.ok(map.beats[index] > map.beats[index - 1], 'beats advance')
  }
}

// Eighth notes keep the pulse at the beat, not at the eighth.
const quick: RawNote[] = Array.from({ length: 24 }, (_, index) => ({ id: `q${index}`, midi: 60 + (index % 5), startBeat: index * 0.5, durationBeats: 0.5 }))
const quickMap = findBeat(spans(sung(96, 0.4, 0, quick)))!
assert.ok(Math.abs(quickMap.bpm / 96 - 1) < 0.06, `eighth notes at 96: found ${quickMap.bpm.toFixed(1)}`)

// A pickup of three short notes into a long one: the long note takes the bar line.
const pickup: RawNote[] = [[60, 1, 1], [64, 2, 1], [65, 3, 1], [67, 4, 4], [60, 9, 1], [64, 10, 1], [65, 11, 1], [67, 12, 4]]
  .map(([midi, startBeat, durationBeats], index) => ({ id: `p${index}`, midi, startBeat, durationBeats }))
const pickupTake = sung(104, 0.3, 0, pickup)
const placedPickup = notesOnBeat(pickupTake, findBeat(spans(pickupTake))!)
assert.equal(Math.round(placedPickup[3].startBeat) % 4, 0, `long note on a bar line, got ${placedPickup[3].startBeat}`)
assert.ok(placedPickup[0].startBeat >= 0 && placedPickup[0].startBeat < 4)

// Too little to find a pulse.
assert.equal(findBeat(spans(sung(100, 0).slice(0, 4))), null)
assert.equal(findBeat([]), null)
console.log('ok tempo: steady and rushing takes at 5 tempos, eighth notes, pickup bar line, too-short takes')
