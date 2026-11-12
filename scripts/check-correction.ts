import assert from 'node:assert/strict'
import { analysisFromNotes, applyQuantize } from '../src/music/analyze.ts'
import { sampleTune } from '../src/music/demo.ts'
import type { RawNote } from '../src/music/theory.ts'

const midis = (notes: RawNote[]) => notes.map((note) => note.midi)
const tune = sampleTune.map((note) => note.midi)

// A singer 45 cents sharp, wobbling ±12 cents: rounding each note separately
// scatters the tune across two keys. In the singer's own tuning it is one tune.
const wobble = [0.1, -0.12, 0.08, -0.05, 0.12, -0.1, 0.02, -0.08, 0.11, -0.12, 0.06, -0.02, 0.09, -0.11]
const sharp = sampleTune.map((note, index) => {
  const sungPitch = note.midi + 0.45 + wobble[index]
  return { ...note, id: `n${index}`, midi: Math.round(sungPitch), sungPitch }
})
assert.notDeepEqual(midis(sharp), tune, 'fixture must start out scattered')
const retuned = midis(analysisFromNotes(sharp).notes)
assert.ok(retuned.every((midi, index) => midi - tune[index] === retuned[0] - tune[0]), `intervals preserved: ${retuned}`)
assert.ok(Math.abs(retuned[0] - tune[0]) <= 1)

// One note sung 40 cents flat lands on a key outside C major; the key decides.
const slip = sampleTune.map((note, index) => {
  const sungPitch = index === 4 ? note.midi - 0.58 : note.midi + 0.02
  return { ...note, id: `n${index}`, midi: Math.round(sungPitch), sungPitch }
})
assert.equal(slip[4].midi, 68)
assert.deepEqual(midis(analysisFromNotes(slip).notes), tune)

// A chromatic note sung squarely in tune is the singer's choice and stays.
const chromatic = sampleTune.map((note, index) => {
  const midi = index === 4 ? 68 : note.midi
  return { ...note, id: `n${index}`, midi, sungPitch: midi + 0.03 }
})
assert.equal(analysisFromNotes(chromatic).notes[4].midi, 68)

// Notes without a measured pitch (the sample tune, older saves) are untouched.
assert.deepEqual(midis(analysisFromNotes(sampleTune).notes), tune)

// Every entry 0.17 beats late (about 110 ms at 92 BPM), unevenly: snapping each
// onset separately put the latest ones a sixteenth late.
const jitter = [0.03, -0.04, 0.05, 0, -0.03, 0.06, -0.05, 0.02, 0.04, -0.02, 0.05, -0.04, 0.01, 0.03]
const lateTake = sampleTune.map((note, index) => ({ ...note, startBeat: note.startBeat + 0.17 + jitter[index], durationBeats: note.durationBeats - 0.2 }))
const naive = lateTake.filter((note, index) => Math.round(note.startBeat / 0.25) * 0.25 !== sampleTune[index].startBeat).length
assert.ok(naive >= 3, 'fixture must defeat per-note snapping')
for (const grid of ['8', '16'] as const) {
  const snapped = applyQuantize(lateTake, grid)
  assert.deepEqual(snapped.map((note) => note.startBeat), sampleTune.map((note) => note.startBeat), `grid ${grid}`)
  snapped.forEach((note, index) => {
    assert.ok(note.durationBeats > 0)
    if (snapped[index + 1]) assert.ok(note.startBeat + note.durationBeats <= snapped[index + 1].startBeat + 1e-9)
  })
}
// A take already on the grid, and a short fragment, are left alone.
assert.deepEqual(applyQuantize(sampleTune, '16').map((note) => note.startBeat), sampleTune.map((note) => note.startBeat))
assert.equal(applyQuantize([{ id: 'a', midi: 60, startBeat: 1.3, durationBeats: 0.5 }], '16')[0].startBeat, 1.25)
// Off-beat (syncopated) entries are not dragged onto the beat.
const offbeat = sampleTune.map((note) => ({ ...note, startBeat: note.startBeat + 0.5, durationBeats: 0.4 }))
assert.deepEqual(applyQuantize(offbeat, '16').map((note) => note.startBeat), offbeat.map((note) => note.startBeat))
console.log('ok correction: singer tuning, key settles between-key notes, chromatic notes kept, shared lateness removed')
