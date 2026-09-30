import assert from 'node:assert/strict'
import { extractSingingNotes } from '../src/music/pitch.ts'
import { segmentSingingNotes, type MelodyFrame } from '../src/music/segment.ts'

const rate = 16000
let checks = 0

// Continuous phase, changing pitch, vocal harmonics, and deterministic breath.
// These exercise note boundaries rather than ideal, isolated sine-wave pitches.
function voice(duration: number, pitch: (time: number) => number, gain: (time: number) => number = () => 0.25): Float32Array {
  const samples = new Float32Array(Math.ceil((duration + 0.2) * rate))
  let phase = 0
  let seed = 483942
  const harmonics = [0.45, 0.8, 0.45, 0.25, 0.16, 0.09, 0.07]
  for (let index = 0; index < samples.length; index++) {
    const time = index / rate
    seed = (1664525 * seed + 1013904223) >>> 0
    const noise = (seed / 4294967296 * 2 - 1) * 0.06
    phase += 2 * Math.PI * 440 * 2 ** ((pitch(time) - 69) / 12) / rate
    let wave = noise
    for (let harmonic = 0; harmonic < harmonics.length; harmonic++) {
      wave += harmonics[harmonic] * Math.sin(phase * (harmonic + 1) + harmonic * 0.18)
    }
    const envelope = time < duration ? gain(time) * Math.min(1, time / 0.012, (duration - time) / 0.02) : 0
    samples[index] = wave * envelope
  }
  return samples
}

function check(name: string, samples: Float32Array, expected: number[]) {
  const notes = extractSingingNotes(samples, rate, 120)
  assert.deepEqual(notes.map((note) => note.midi), expected, name)
  notes.forEach((note, index) => {
    assert.ok(note.durationBeats > 0 && Number.isFinite(note.durationBeats))
    if (index) assert.ok(notes[index - 1].startBeat + notes[index - 1].durationBeats <= note.startBeat + 0.001)
  })
  checks++
  return notes
}

// Frozen pre-change results for these contours were [58,60] and
// [60,61,64,63,62]: transient scoops/slides were emitted as extra notes.
for (const scoop of [0.18, 0.25]) {
  check(`onset scoop ${scoop}`, voice(1.2, (time) => 60 - 3 * Math.max(0, 1 - time / scoop)
    + 0.3 * Math.sin(2 * Math.PI * 5 * time)), [60])
}
for (const glide of [0.15, 0.2]) {
  check(`legato portamento ${glide}`, voice(1.8, (time) => {
    const target = time < 0.6 ? 60 : time < 1.2 ? 64 : 62
    const previous = time < 0.6 ? 60 : time < 1.2 ? 60 : 64
    return previous + (target - previous) * Math.min(1, (time % 0.6) / glide)
      + 0.3 * Math.sin(2 * Math.PI * 5.5 * time)
  }), [60, 64, 62])
}

// Previously one held E4 became up to eleven alternating Eb4/F4 notes.
for (const phase of [0, 0.25, 0.5, 0.75]) {
  check(`wide vibrato, phase ${phase}`, voice(1.2, (time) => 64
    + 0.8 * Math.sin(2 * Math.PI * (4.5 * time + phase))), [64])
}
check('slow vibrato near a rounding boundary', voice(1.2, (time) => 64
  + 0.65 * Math.sin(2 * Math.PI * (3.5 * time + 0.75))), [64])

// Both Db notes were previously missing: [60,62,60]. Distinct short notes must
// survive; simply increasing a global minimum duration cannot fix this case.
for (const length of [0.14, 0.15]) {
  check(`quick chromatic notes ${length}`, voice(length * 5, (time) => [60, 61, 62, 61, 60][Math.min(4, Math.floor(time / length))]
    + 0.3 * Math.sin(2 * Math.PI * 5 * time)), [60, 61, 62, 61, 60])
}

const repeated = check('rearticulated equal notes without silence', voice(1.3,
  (time) => 64 + 0.3 * Math.sin(2 * Math.PI * 5 * time),
  (time) => {
    const valley = Math.max(0, 1 - Math.abs(time % 0.45 - 0.41) / 0.06)
    return 0.25 * (1 - valley * 0.98)
  }), [64, 64, 64])
assert.ok(Math.abs(repeated[1].startBeat / 2 - 0.41) < 0.04)
assert.ok(Math.abs(repeated[2].startBeat / 2 - 0.86) < 0.04)

const frames: MelodyFrame[] = Array.from({ length: 60 }, (_, index) => ({ time: index / 100, pitch: 64, energy: 0.1 }))
const uncertain = frames.map((frame, index) => ({ ...frame, pitch: index === 25 || index === 26 ? null : frame.pitch }))
assert.equal(segmentSingingNotes(uncertain, 0.6).length, 1, 'brief uncertain frames should not split a held note')
const rest = frames.map((frame, index) => index >= 25 && index <= 30 ? { ...frame, pitch: null, energy: 0 } : frame)
assert.equal(segmentSingingNotes(rest, 0.6).length, 2, 'a genuine rest must keep repeated notes separate')
checks += 2
console.log(`ok segmentation: ${checks} expressive contours, quick notes, reattacks, and voicing gaps`)
