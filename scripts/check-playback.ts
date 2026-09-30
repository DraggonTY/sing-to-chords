import assert from 'node:assert/strict'
import { makePlaybackPlan } from '../src/audio/playback.ts'
import { chordPalette } from '../src/music/theory.ts'

const song = {
  recordedBpm: 92,
  raw: [
    { id: 'first', midi: 76, startBeat: 0.13, durationBeats: 0.41 },
    { id: 'second', midi: 78, startBeat: 0.64, durationBeats: 0.57 },
  ],
}
const arrangement = {
  notes: song.raw.map((note, index) => ({ ...note, startBeat: index * 0.5, durationBeats: 0.5 })),
  chords: [{ startBeat: 0, durationBeats: 2, chord: chordPalette({ tonic: 0, mode: 'major' })[0] }],
  bpm: 160,
  hearMelody: false,
  withClick: true,
}
const before = JSON.stringify({ song, arrangement })

// Audition the completed take, even when arrangement controls ask for a faster,
// quantized accompaniment with its melody muted and the click enabled.
const isolated = makePlaybackPlan(song, arrangement, true)
assert.equal(isolated.bpm, 92)
assert.equal(isolated.withClick, false)
assert.deepEqual(isolated.notes, [
  { midi: 76, startBeat: 0.13, durationBeats: 0.41, velocity: 72 },
  { midi: 78, startBeat: 0.64, durationBeats: 0.57, velocity: 72 },
])

const chords = makePlaybackPlan(song, arrangement, false)
assert.equal(chords.bpm, 160)
assert.equal(chords.withClick, true)
assert.ok(chords.notes.length >= 3)
assert.ok(chords.notes.every((note) => note.velocity === 96))

const both = makePlaybackPlan(song, { ...arrangement, hearMelody: true }, false)
assert.equal(both.notes.length, chords.notes.length + 2)
assert.deepEqual(both.notes.slice(-2), [
  { midi: 76, startBeat: 0, durationBeats: 0.5, velocity: 72 },
  { midi: 78, startBeat: 0.5, durationBeats: 0.5, velocity: 72 },
])
assert.equal(makePlaybackPlan({ ...song, recordedBpm: 96 }, arrangement, true).bpm, 96)
assert.equal(JSON.stringify({ song, arrangement }), before, 'playback must not mutate either note list')
console.log('ok playback: original melody timing/tempo, isolated notes, arrangement controls, immutable inputs')
