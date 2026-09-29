import { analyzeNoteList, analyzeRecording, applyQuantize, layoutChords } from '../src/music/analyze.ts'
import { sampleTune } from '../src/music/demo.ts'
import { chordEvents, encodePianoMidi } from '../src/music/midi.ts'

const bpm = 100
const sampleRate = 16000
const melody = [
  { midi: 60, startBeat: 0, durationBeats: 0.9 },
  { midi: 64, startBeat: 1, durationBeats: 0.9 },
  { midi: 67, startBeat: 2, durationBeats: 0.9 },
  { midi: 72, startBeat: 3, durationBeats: 0.9 },
]

const audio = new Float32Array(Math.ceil(5.2 * (60 / bpm) * sampleRate))
for (const note of melody) {
  const freq = 440 * 2 ** ((note.midi - 69) / 12)
  const start = Math.floor(note.startBeat * (60 / bpm) * sampleRate)
  const end = Math.floor((note.startBeat + note.durationBeats) * (60 / bpm) * sampleRate)
  for (let index = start; index < end && index < audio.length; index++) {
    const t = index / sampleRate
    const env = Math.min(1, (index - start) / 80) * Math.min(1, (end - index) / 200)
    audio[index] += Math.sin(2 * Math.PI * freq * t) * 0.5 * env
    audio[index] += Math.sin(2 * Math.PI * freq * 2 * t) * 0.15 * env
  }
}

const analysis = analyzeRecording(audio, sampleRate, bpm)
if (analysis.key.tonic !== 0 || analysis.key.mode !== 'major') {
  throw new Error(`expected C major, got ${analysis.key.tonic} ${analysis.key.mode}`)
}
if (analysis.notes.length < 4) throw new Error(`expected 4 notes, got ${analysis.notes.length} (${analysis.notes.map((note) => note.midi).join(',')})`)
analysis.notes.slice(0, 4).forEach((note, index) => {
  if (Math.abs(note.midi - melody[index].midi) > 1) {
    throw new Error(`note ${index} heard ${note.midi}, wanted ${melody[index].midi}`)
  }
})

const voice = voiceMelody(
  [
    { midi: 45, startBeat: 0, durationBeats: 1.1 },
    { midi: 60, startBeat: 1.4, durationBeats: 1 },
    { midi: 64, startBeat: 2.6, durationBeats: 0.9 },
  ],
  bpm,
  sampleRate,
)
const sung = analyzeRecording(voice, sampleRate, bpm)
const heard = sung.notes.map((note) => note.midi)
if (heard.length < 3 || heard.slice(0, 3).some((midi, index) => Math.abs(midi - [45, 60, 64][index]) > 0)) {
  throw new Error(`voice pitches drifted: ${heard.join(',')}`)
}

const flatMelody = [
  { midi: 59.55, startBeat: 0, durationBeats: 1 },
  { midi: 61.55, startBeat: 1.2, durationBeats: 1 },
  { midi: 63.55, startBeat: 2.4, durationBeats: 1 },
  { midi: 66.5, startBeat: 3.6, durationBeats: 1 },
]
const flat = analyzeRecording(voiceMelody(flatMelody, bpm, sampleRate), sampleRate, bpm)
const flatHeard = flat.notes.map((note) => note.midi)
const flatTargets = [59.55, 61.55, 63.55, 66.5]
if (flat.notes.length < 4 || flatHeard.slice(0, 4).some((midi, index) => Math.abs(midi - flatTargets[index]) > 0.75)) {
  throw new Error(`flat melody lost notes: ${flatHeard.join(',')} key=${flat.key.tonic} ${flat.key.mode}`)
}

const chromatic = analyzeRecording(
  voiceMelody(
    [
      { midi: 60, startBeat: 0, durationBeats: 1 },
      { midi: 66.12, startBeat: 1.2, durationBeats: 1 },
      { midi: 67, startBeat: 2.4, durationBeats: 1 },
      { midi: 64, startBeat: 3.6, durationBeats: 1 },
    ],
    bpm,
    sampleRate,
  ),
  sampleRate,
  bpm,
)
if (!chromatic.notes.some((note) => note.midi === 66)) {
  throw new Error(`kept a real F# from being swallowed: ${chromatic.notes.map((note) => note.midi).join(',')}`)
}

const quick = analyzeRecording(
  voiceMelody(
    [60, 62, 64, 65, 67].map((midi, index) => ({ midi, startBeat: index * 0.75, durationBeats: 0.55 })),
    108,
    sampleRate,
  ),
  sampleRate,
  108,
)
if (quick.notes.map((note) => note.midi).join(',') !== '60,62,64,65,67') {
  throw new Error(`missed fast notes: ${quick.notes.map((note) => note.midi).join(',')}`)
}

const late = analyzeNoteList([
  { id: 'a', midi: 64, startBeat: 1.2, durationBeats: 0.7 },
  { id: 'b', midi: 67, startBeat: 2, durationBeats: 1 },
])
const quantized = applyQuantize(late.notes, '16')
if (Math.abs(quantized[0].startBeat - 1.25) > 0.001) {
  throw new Error(`quantize failed: ${quantized[0].startBeat}`)
}

const song = layoutChords(analysis.notes, analysis.key, {}, 2)
if (song[0]?.chord.symbol !== 'C') throw new Error(`expected C on the first half, got ${song[0]?.chord.symbol}`)
const swapped = layoutChords(analysis.notes, analysis.key, { [song[0].id]: song[0].options[1].id }, 2)
if (swapped[0].chord.id !== song[0].options[1].id) throw new Error('chord override failed')

const tune = analyzeNoteList(sampleTune)
const tuneSlots = layoutChords(applyQuantize(tune.notes, '16'), tune.key, {}, 2)
if (tuneSlots.length > 8) throw new Error(`too many chords: ${tuneSlots.length}`)
const progression = tuneSlots.map((slot) => slot.chord.symbol).join(' ')
if (progression !== 'C C F C F C G C') {
  throw new Error(`sample chords drifted: ${progression}`)
}

const bytes = encodePianoMidi(chordEvents(song), bpm)
const header = String.fromCharCode(...bytes.slice(0, 4))
if (header !== 'MThd') throw new Error(`bad midi header ${header}`)
if (!bytes.includes(0x90)) throw new Error('midi has no note on')
if (bytes[12] !== 0x01) throw new Error('midi is not a single track')

console.log(
  `ok key=C major chords=${song.map((slot) => slot.chord.symbol).join(' ')} sample=${tuneSlots.map((slot) => slot.chord.symbol).join(' ')} voice=${heard.join(',')} midi=${bytes.length}b`,
)

function voiceMelody(
  notes: { midi: number; startBeat: number; durationBeats: number }[],
  tempo: number,
  rate: number,
): Float32Array {
  const beats = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0) + 0.4
  const output = new Float32Array(Math.ceil(beats * (60 / tempo) * rate))
  for (const note of notes) {
    const base = 440 * 2 ** ((note.midi - 69) / 12)
    const start = Math.floor(note.startBeat * (60 / tempo) * rate)
    const end = Math.floor((note.startBeat + note.durationBeats) * (60 / tempo) * rate)
    let phase = 0
    for (let index = start; index < end && index < output.length; index++) {
      const t = index / rate
      const vibrato = Math.sin(2 * Math.PI * 5.2 * t) * 0.55
      const freq = base * 2 ** (vibrato / 12)
      phase += (2 * Math.PI * freq) / rate
      const env = Math.min(1, (index - start) / 180) * Math.min(1, (end - index) / 300)
      const fundamental = note.midi < 50 ? 0.55 : 1
      let sample = Math.sin(phase) * fundamental
      sample += Math.sin(phase * 2) * 0.72
      sample += Math.sin(phase * 3) * 0.32
      sample += Math.sin(phase * 4) * 0.14
      output[index] += sample * 0.35 * env + (Math.random() * 2 - 1) * 0.01 * env
    }
  }
  return output
}
