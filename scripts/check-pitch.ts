import assert from 'node:assert/strict'
import { extractSingingNotes } from '../src/music/pitch.ts'
import { transcribeSinging } from '../src/music/transcribe.ts'

type SungNote = { midi: number; start: number; duration: number; gain?: number; vibrato?: number }
type VoiceOptions = { harmonics?: number[]; noise?: number; dc?: number; clipped?: boolean }
let fixtures = 0

function synth(notes: SungNote[], rate: number, options: VoiceOptions = {}): Float32Array {
  const length = Math.ceil((Math.max(0, ...notes.map((note) => note.start + note.duration)) + 0.15) * rate)
  const output = new Float32Array(length)
  let state = 1234567
  const noise = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000 * 2 - 1 }
  for (let index = 0; index < output.length; index++) output[index] = noise() * (options.noise ?? 0) + (options.dc ?? 0)
  for (const note of notes) {
    let phase = 0
    const begin = Math.floor(note.start * rate)
    const end = Math.floor((note.start + note.duration) * rate)
    for (let index = begin; index < end; index++) {
      const local = (index - begin) / rate
      const envelope = Math.min(1, local / 0.012, (end - index) / rate / 0.018)
      const midi = note.midi + (note.vibrato ?? 0) * Math.sin(2 * Math.PI * 5.3 * local)
      phase += 2 * Math.PI * 440 * 2 ** ((midi - 69) / 12) / rate
      let wave = 0
      for (const [index, gain] of (options.harmonics ?? [0.6, 1, 0.45, 0.2, 0.12]).entries()) {
        wave += Math.sin(phase * (index + 1) + index * 0.18) * gain
      }
      output[index] += wave * (note.gain ?? 0.25) * envelope
      if (options.clipped) output[index] = Math.max(-0.3, Math.min(0.3, output[index]))
    }
  }
  return output
}

function check(name: string, notes: SungNote[], rate = 16000, options: VoiceOptions = {}) {
  const result = extractSingingNotes(synth(notes, rate, options), rate, 120)
  assert.deepEqual(result.map((note) => note.midi), notes.map((note) => Math.round(note.midi)), `${name}: pitches/count`)
  result.forEach((note, index) => {
    const expected = notes[index]
    assert.ok(Math.abs(note.startBeat / 2 - expected.start) < 0.065, `${name}: onset ${index} (${note.startBeat / 2}, expected ${expected.start})`)
    assert.ok(Math.abs((note.startBeat + note.durationBeats) / 2 - (expected.start + expected.duration)) < 0.075, `${name}: offset ${index}`)
    assert.ok(note.durationBeats > 0 && Number.isFinite(note.durationBeats), `${name}: finite duration`)
    if (index) assert.ok(result[index - 1].startBeat + result[index - 1].durationBeats <= note.startBeat + 0.001, `${name}: overlap`)
  })
  fixtures++
  return result
}

for (const rate of [8000, 12000, 16000, 22050, 44100, 48000]) {
  check(`sample rate ${rate}`, [45, 60, 64, 67, 72, 81].map((midi, index) => ({ midi, start: 0.2 + index * 0.42, duration: 0.33, vibrato: 0.4 })), rate)
}
check('missing fundamental', [{ midi: 57, start: 0.1, duration: 0.9 }, { midi: 65, start: 1.1, duration: 0.6 }], 44100, { harmonics: [0, 1, 0.8, 0.4] })
check('dominant second harmonic', [48, 60, 69].map((midi, index) => ({ midi, start: index * 0.7, duration: 0.5 })), 48000, { harmonics: [0.15, 1, 0.18, 0.1] })
check('short octave leaps', [60, 72, 60, 48, 60].map((midi, index) => ({ midi, start: index * 0.24, duration: 0.24 })))
check('chromatic legato', [60, 61, 62, 61, 60].map((midi, index) => ({ midi, start: index * 0.24, duration: 0.24 })))
for (const step of [0.72, 0.8, 0.84, 0.86]) {
  check(`slightly flat semitone ${step}`, [{ midi: 60, start: 0, duration: 0.5 }, { midi: 60 + step, start: 0.5, duration: 1.3 }], 12000, { harmonics: [1] })
}
check('vibrato', [{ midi: 64, start: 0.1, duration: 2, vibrato: 0.65 }])
check('repeated notes with short rests', [0, 0.36, 0.72].map((start) => ({ midi: 64, start, duration: 0.3 })))
check('noise and DC', [55, 62, 67].map((midi, index) => ({ midi, start: 0.2 + index * 0.7, duration: 0.5, vibrato: 0.4 })), 44100, { noise: 0.05, dc: 0.3 })
check('moderate microphone noise', [{ midi: 57, start: 0.1, duration: 0.8, gain: 0.15 }, { midi: 64, start: 1.1, duration: 0.7, gain: 0.15 }], 16000, { noise: 0.1 })
check('soft phrase after loud note', [{ midi: 60, start: 0, duration: 0.5 }, { midi: 64, start: 0.65, duration: 0.5, gain: 0.015 }])
check('quiet recording', [{ midi: 62, start: 0.1, duration: 0.7, gain: 0.0003 }])
check('clipped microphone', [{ midi: 60, start: 0.1, duration: 0.7, gain: 0.8, vibrato: 0.3 }], 48000, { clipped: true })
check('lowest supported voice', [{ midi: 34, start: 0.1, duration: 0.8 }])
check('high voice', [{ midi: 86, start: 0.1, duration: 0.8 }])

for (const [name, audio, rate] of [
  ['silence', new Float32Array(16000), 16000],
  ['DC', new Float32Array(16000).fill(0.4), 16000],
  ['breath noise', synth([], 48000, { noise: 0.15 }), 48000],
  ['short transient', Float32Array.from({ length: 16000 }, (_, index) => index === 3000 ? 1 : 0), 16000],
  ['out of range high tone', Float32Array.from({ length: 48000 }, (_, index) => Math.sin(2 * Math.PI * 11000 * index / 48000) * 0.5), 48000],
  ['high whistle subharmonic', Float32Array.from({ length: 16000 }, (_, index) => Math.sin(2 * Math.PI * 1800 * index / 16000) * 0.5), 16000],
] as const) {
  assert.deepEqual(extractSingingNotes(audio, rate, 120), [], name)
  fixtures++
}
assert.deepEqual(extractSingingNotes(new Float32Array(), 48000, 120), [])
assert.throws(() => extractSingingNotes(new Float32Array(16000), 0, 120), RangeError)
assert.throws(() => extractSingingNotes(new Float32Array(16000), 16000, Number.NaN), RangeError)
const sample = synth([{ midi: 60, start: 0.1, duration: 0.7 }], 16000)
const original = sample.slice()
const asyncResult = await transcribeSinging(sample, 16000, 120)
assert.deepEqual(asyncResult.notes, extractSingingNotes(sample, 16000, 120), 'async engine agrees with synchronous engine')
assert.deepEqual(sample, original, 'transcription leaves playback samples untouched')
const cancelled = new AbortController()
cancelled.abort()
await assert.rejects(transcribeSinging(sample, 16000, 120, cancelled.signal), { name: 'AbortError' })
console.log(`ok pitch: ${fixtures} synthetic fixtures, timing, sample rates, octave leaps, rests, noise, and async parity`)
