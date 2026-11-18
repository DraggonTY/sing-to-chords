import assert from 'node:assert/strict'
import { gameNotes, GAME_CONTEXT_SPANS, type GameRuntime, type GameTensor } from '../src/music/game.ts'
import { boundaryFeatures, startsNewNote, tidyGameNotes } from '../src/music/gameTidy.ts'

// A stand-in for the model graphs: each call is recorded, and the "model" reports
// a fixed set of notes per piece of audio, so the plumbing can be checked exactly.
const WIDTH = 4
const calls: string[] = []
const PIECE = [
  { duration: 0.5, present: false, pitch: 0 }, // silence before the voice
  { duration: 0.2, present: true, pitch: 62.4 },
  { duration: 0.6, present: true, pitch: 64.0 },
  { duration: 0.3, present: false, pitch: 0 },
  { duration: 0.4, present: true, pitch: 67.1 },
]
const runtime: GameRuntime = async (module, feeds) => {
  calls.push(module)
  if (module === 'encoder') {
    const waveform = feeds.waveform as GameTensor
    assert.equal(waveform.dims[0], 1)
    const frames = Math.round((feeds.duration as GameTensor).data[0] as number / 0.01)
    const x = new Float32Array(frames * WIDTH)
    for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < WIDTH; channel++) x[frame * WIDTH + channel] = frame + channel / 10
    return { x_seg: { data: x, dims: [1, frames, WIDTH] }, x_est: { data: x, dims: [1, frames, WIDTH] }, maskT: { data: new Uint8Array(frames).fill(1), dims: [1, frames] } }
  }
  if (module === 'dur2bd') return { boundaries: { data: new Uint8Array(feeds.maskT.dims[1]), dims: feeds.maskT.dims } }
  if (module === 'segmenter') {
    assert.ok((feeds.t as GameTensor).data[0] as number >= 0 && ((feeds.t as GameTensor).data[0] as number) < 1)
    return { boundaries: feeds.prev_boundaries }
  }
  if (module === 'bd2dur') return { durations: { data: Float32Array.from([...PIECE.map((note) => note.duration), 9]), dims: [1, PIECE.length + 1] }, maskN: { data: Uint8Array.from([...PIECE.map(() => 1), 0]), dims: [1, PIECE.length + 1] } }
  return { presence: { data: Uint8Array.from([...PIECE.map((note) => Number(note.present)), 1]), dims: [1, PIECE.length + 1] }, scores: { data: Float32Array.from([...PIECE.map((note) => note.pitch), 99]), dims: [1, PIECE.length + 1] } }
}

const seconds = 2
const audio = new Float32Array(44100 * seconds)
for (let index = 0; index < audio.length; index++) audio[index] = 0.2 * Math.sin(2 * Math.PI * 220 * index / 44100)
const progress: number[] = []
const notes = await gameNotes(audio, 44100, runtime, (done) => progress.push(done))
assert.deepEqual(notes.map((note) => [Number(note.start.toFixed(2)), Number(note.end.toFixed(2)), Number(note.pitch.toFixed(1))]), [[0.5, 0.7, 62.4], [0.7, 1.3, 64], [1.6, 2, 67.1]], 'voiced notes only, on the running clock, padding ignored')
assert.equal(calls.filter((name) => name === 'segmenter').length, 8, 'eight refinement passes')
assert.deepEqual([calls[0], calls[1], calls.at(-2), calls.at(-1)], ['encoder', 'dur2bd', 'bd2dur', 'estimator'])
assert.deepEqual(progress, [1])
// Context: the encoder features pooled over five spans around the note's start (frame 50 for the first note).
assert.equal(notes[0].context.length, GAME_CONTEXT_SPANS * WIDTH)
assert.ok(Math.abs(notes[0].context[0] - (34 + 41) / 2) < 1e-4, `frames 34..41 average, got ${notes[0].context[0]}`)
assert.ok(Math.abs(notes[0].context[2 * WIDTH + 1] - (49.5 + 0.1)) < 1e-4, 'middle span straddles the boundary')

// A long recording is cut at quiet moments and the pieces keep their place in time.
calls.length = 0
const long = new Float32Array(44100 * 45)
for (let index = 0; index < long.length; index++) long[index] = (Math.floor(index / 44100) % 10 === 9 ? 0.001 : 0.2) * Math.sin(2 * Math.PI * 220 * index / 44100)
const steps: number[] = []
const longNotes = await gameNotes(long, 44100, runtime, (done) => steps.push(done))
const pieces = calls.filter((name) => name === 'encoder').length
assert.ok(pieces >= 3, `45 s in pieces of at most 20 s, got ${pieces}`)
assert.equal(longNotes.length, pieces * 3)
assert.equal(steps.length, pieces)
assert.equal(steps.at(-1), 1)
for (let index = 1; index < longNotes.length; index++) assert.ok(longNotes[index].start >= longNotes[index - 1].end - 1e-6, 'notes stay in order across pieces')
assert.ok(longNotes.at(-1)!.start > 20)

// Other sample rates are resampled; unusable input is refused or empty.
assert.equal((await gameNotes(new Float32Array(16000 * 2).fill(0.1), 16000, runtime)).length, 3)
assert.deepEqual(await gameNotes(new Float32Array(100), 44100, runtime), [])
await assert.rejects(() => gameNotes(audio, 1000, runtime), RangeError)

// Clean-up: every decision is a probability, and merging never loses time or reorders notes.
const context = (seed: number) => Float32Array.from({ length: 640 }, (_, index) => Math.sin(seed * 7.3 + index * 0.37) * 0.5)
const phrase = [
  { start: 1.0, end: 1.12, pitch: 62.4, context: context(1) }, // scoop-like: short, below, off the grid of pitches
  { start: 1.12, end: 1.7, pitch: 64.0, context: context(2) },
  { start: 1.7, end: 2.2, pitch: 64.0, context: context(3) },
  { start: 2.6, end: 3.1, pitch: 67.0, context: context(4) }, // after a rest: never joined to what came before
]
assert.equal(boundaryFeatures(phrase, 1).length, 640 + 15)
for (const index of [1, 2]) { const p = startsNewNote(phrase, index); assert.ok(p >= 0 && p <= 1 && Number.isFinite(p), `probability, got ${p}`) }
const tidy = tidyGameNotes(phrase)
assert.ok(tidy.length >= 2 && tidy.length <= 4)
assert.equal(tidy[0].startBeat, 1)
assert.equal(tidy.at(-1)!.startBeat, 2.6)
assert.ok(Math.abs(tidy.reduce((sum, note) => sum + note.durationBeats, 0) - 1.7) < 0.01, 'no sung time is dropped')
tidy.forEach((note, index) => { assert.ok(Number.isInteger(note.midi)); if (index) assert.ok(note.startBeat >= tidy[index - 1].startBeat + tidy[index - 1].durationBeats - 1e-6) })
assert.deepEqual(tidyGameNotes([]), [])
console.log('ok GAME engine: note timing, refinement passes, context pooling, long recordings in pieces, resampling, clean-up invariants')
