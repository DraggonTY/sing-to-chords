import assert from 'node:assert/strict'
import { analyzeNoteList, analysisFromNotes, applyQuantize, layoutChords } from '../src/music/analyze.ts'
import { chordEvents, encodePianoMidi } from '../src/music/midi.ts'
import { chordById, chordPalette, keyFromMelody, makeChord, pitchClass, voiceChord, type RawNote } from '../src/music/theory.ts'
import { sampleTune } from '../src/music/demo.ts'

let checks = 0
function check(name: string, run: () => void) {
  run()
  checks++
  console.log(`ok ${name}`)
}
function melody(pitches: number[]): RawNote[] {
  return pitches.map((midi, i) => ({ id: `note-${i}`, midi, startBeat: i, durationBeats: i === pitches.length - 1 ? 2 : 1 }))
}
const cMajor = { tonic: 0, mode: 'major' as const }

check('major and minor key detection transposes across all 12 tonics', () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const third = mode === 'major' ? 4 : 3
      const notes = melody([0, third, 7, 12, 7, third, 0].map((pc) => 48 + tonic + pc))
      assert.deepEqual(analyzeNoteList(notes).key, { tonic, mode })
      assert.deepEqual(analyzeNoteList(notes), analysisFromNotes(notes))
    }
  }
})
check('sparse and empty input cannot claim a strong key', () => {
  assert.equal(analyzeNoteList([]).confidence, 0)
  assert.ok(keyFromMelody([{ pitch: 69, weight: 12 }]).confidence < 0.35)
  assert.ok(keyFromMelody(Array.from({ length: 12 }, (_, pitch) => ({ pitch, weight: 1 }))).confidence < 0.35)
})
check('chord palettes stay diatonic except the intentional major dominant in minor', () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const scale = (mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10])
        .map((degree) => pitchClass(tonic + degree))
      for (const chord of chordPalette({ tonic, mode })) {
        const majorDominant = mode === 'minor' && pitchClass(chord.root - tonic) === 7
          && (chord.quality === 'maj' || chord.quality === '7')
        assert.ok(chord.tones.every((tone) => scale.includes(tone)
          || (majorDominant && tone === pitchClass(tonic + 11))))
      }
    }
  }
  const aMinor = chordPalette({ tonic: 9, mode: 'minor' })
  assert.ok(aMinor.some((chord) => chord.id === '7:7'))
  assert.ok(!aMinor.some((chord) => chord.id === '7:maj7'))
})
check('quantization preserves order and avoids overlaps for colliding quick notes', () => {
  const source = [
    { id: 'high', midi: 67, startBeat: 0.01, durationBeats: 0.15 },
    { id: 'low', midi: 60, startBeat: 0.1, durationBeats: 0.2 },
    { id: 'third', midi: 64, startBeat: 0.53, durationBeats: 0.3 },
  ]
  const before = structuredClone(source)
  for (const grid of ['8', '16'] as const) {
    const quantized = applyQuantize(source, grid)
    assert.deepEqual(quantized.map((note) => note.id), ['high', 'low', 'third'])
    quantized.forEach((note, index) => {
      assert.ok(note.durationBeats > 0)
      const next = quantized[index + 1]
      if (next) assert.ok(note.startBeat + note.durationBeats <= next.startBeat + 1e-9)
    })
  }
  assert.deepEqual(source, before)
})
check('held notes support every overlapped chord window and the last slot ends with the melody', () => {
  const notes = [{ id: 'held', midi: 64, startBeat: 0, durationBeats: 5.25 }]
  const slots = layoutChords(notes, cMajor, {}, 2)
  assert.deepEqual(slots.map((slot) => slot.startBeat), [0, 2, 4])
  assert.equal(slots.at(-1)!.durationBeats, 1.25)
  assert.ok(slots.every((slot) => slot.chord.tones.includes(4)))
})
check('empty windows stay silent and choices remain available', () => {
  const notes = [
    { id: 'first', midi: 60, startBeat: 0, durationBeats: 1 },
    { id: 'last', midi: 60, startBeat: 8, durationBeats: 1 },
  ]
  const slots = layoutChords(notes, cMajor, {}, 2)
  assert.deepEqual(slots.map((slot) => slot.startBeat), [0, 8])
  assert.ok(slots.every((slot) => slot.options.some((option) => option.id === slot.chord.id)))
})
check('valid manual chords survive reranking and invalid edits are ignored', () => {
  const notes = melody([60, 64, 67, 60])
  const slots = layoutChords(notes, cMajor, { '2@0': '6:min', '2@2': 'broken' }, 2)
  assert.equal(slots[0].chord.id, '6:min')
  assert.equal(slots[0].edited, true)
  assert.ok(slots[0].options.some((option) => option.id === '6:min'))
  assert.equal(slots[1].edited, false)
  assert.equal(chordById('0:toString'), null)
})
check('sample harmony covers structural melody notes and resolves to the tonic', () => {
  const detected = analyzeNoteList(sampleTune)
  assert.deepEqual(detected.key, cMajor)
  const slots = layoutChords(sampleTune, detected.key, {}, 2)
  assert.equal(slots.length, 8)
  assert.equal(slots.at(-1)!.chord.id, '0:maj')
  for (const slot of slots) {
    const notes = sampleTune.filter((note) => note.startBeat < slot.startBeat + slot.durationBeats
      && note.startBeat + note.durationBeats > slot.startBeat)
    assert.ok(notes.every((note) => slot.chord.tones.includes(pitchClass(note.midi))))
  }
})
check('a later chord choice influences earlier ambiguous harmony', () => {
  const notes = [
    { id: 'd', midi: 62, startBeat: 0, durationBeats: 2 },
    { id: 'c', midi: 60, startBeat: 2, durationBeats: 2 },
  ]
  const automatic = layoutChords(notes, cMajor, {}, 2)
  const edited = layoutChords(notes, cMajor, { '2@2': '5:maj' }, 2)
  assert.notEqual(automatic[0].chord.id, edited[0].chord.id)
  assert.equal(edited[1].chord.id, '5:maj')
  assert.equal(edited[1].edited, true)
  for (const slots of [automatic, edited]) {
    slots.forEach((slot, index) => assert.ok(slot.chord.tones.includes(pitchClass(notes[index].midi))))
  }
})
check('piano voices stay ordered, in range, and on chord tones', () => {
  let previous: number[] | null = null
  for (const root of [0, 9, 5, 7, 0, 2, 7, 0]) {
    const chord = makeChord(root, root === 9 || root === 2 ? 'min' : 'maj')
    const voiced = voiceChord(chord, previous)
    assert.ok(voiced.every((midi, i) => midi >= 36 && midi <= 84
      && chord.tones.includes(pitchClass(midi)) && (i === 0 || midi > voiced[i - 1])))
    if (previous) {
      const movement = voiced.reduce((sum, midi, i) => sum + Math.abs(midi - previous![i]), 0)
      assert.ok(movement <= 18, `excessive movement: ${previous} -> ${voiced}`)
    }
    previous = voiced
  }
})
check('MIDI event stream contains every exported note with positive duration and tempo', () => {
  const events = chordEvents(layoutChords(sampleTune, cMajor, {}, 2))
  const bytes = encodePianoMidi(events, 120)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'MThd')
  assert.equal(new TextDecoder().decode(bytes.slice(14, 18)), 'MTrk')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(18), bytes.length - 22)
  let cursor = 22
  let tick = 0
  const active = new Map<number, number>()
  let onsets = 0
  let tempo = 0
  while (cursor < bytes.length) {
    let delta = 0
    let part: number
    do {
      part = bytes[cursor++]
      delta = (delta << 7) | (part & 0x7f)
    } while (part & 0x80)
    tick += delta
    const status = bytes[cursor++]
    if (status === 0xff) {
      const type = bytes[cursor++]
      const length = bytes[cursor++]
      if (type === 0x51) tempo = (bytes[cursor] << 16) | (bytes[cursor + 1] << 8) | bytes[cursor + 2]
      cursor += length
    } else if (status === 0xc0) {
      cursor++
    } else {
      const midi = bytes[cursor++]
      const velocity = bytes[cursor++]
      if (status === 0x90 && velocity > 0) {
        assert.ok(!active.has(midi), `duplicate active pitch ${midi}`)
        active.set(midi, tick)
        onsets++
      } else {
        assert.ok(active.has(midi))
        assert.ok(tick > active.get(midi)!)
        active.delete(midi)
      }
    }
  }
  assert.equal(tempo, 500000)
  assert.equal(onsets, events.length)
  assert.equal(active.size, 0)
})
console.log(`${checks} engine integration checks passed`)
