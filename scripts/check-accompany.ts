import assert from 'node:assert/strict'
import { PIANO_STYLES, pianoEvents } from '../src/music/accompany.ts'
import { layoutChords } from '../src/music/analyze.ts'
import { sampleTune } from '../src/music/demo.ts'
import { chordEvents, encodePianoMidi } from '../src/music/midi.ts'
import { pitchClass } from '../src/music/theory.ts'

const cMajor = { tonic: 0, mode: 'major' } as const

for (const span of [1, 2, 4] as const) {
  for (const rich of [false, true]) {
    const slots = layoutChords(sampleTune, cMajor, {}, span, rich)
    const end = slots.reduce((max, slot) => Math.max(max, slot.startBeat + slot.durationBeats), 0)
    for (const [style] of PIANO_STYLES) {
      const label = `${style} span=${span} rich=${rich}`
      const events = pianoEvents(slots, style)
      assert.ok(events.length >= slots.length, `${label}: every chord sounds`)
      for (const slot of slots) {
        assert.ok(events.some((event) => Math.abs(event.startBeat - slot.startBeat) < 1e-6), `${label}: chord at ${slot.startBeat} starts on time`)
      }
      for (const event of events) {
        assert.ok(event.durationBeats >= 0.1, `${label}: audible length ${event.durationBeats}`)
        assert.ok(event.midi >= 28 && event.midi <= 84, `${label}: register ${event.midi}`)
        assert.ok(event.velocity >= 1 && event.velocity <= 127, `${label}: velocity`)
        assert.ok(event.startBeat + event.durationBeats <= end + 1e-6, `${label}: ends with the melody`)
        const slot = slots.findLast((item) => item.startBeat <= event.startBeat + 1e-6)!
        assert.ok(slot.chord.tones.includes(pitchClass(event.midi)), `${label}: ${event.midi} belongs to ${slot.chord.symbol}`)
        // Nothing may ring into a different chord.
        const next = slots[slots.indexOf(slot) + 1]
        if (next) assert.ok(event.startBeat + event.durationBeats <= next.startBeat + 1e-6, `${label}: rings into the next chord`)
      }
      // A piano key cannot be restruck while it is still held.
      const byKey = new Map<number, number>()
      for (const event of events.slice().sort((a, b) => a.startBeat - b.startBeat)) {
        assert.ok((byKey.get(event.midi) ?? -1) <= event.startBeat + 1e-6, `${label}: overlapping ${event.midi}`)
        byKey.set(event.midi, event.startBeat + event.durationBeats)
      }
      if (style !== 'block') {
        const lowestBlock = Math.min(...chordEvents(slots).map((event) => event.midi))
        assert.ok(Math.min(...events.map((event) => event.midi)) < lowestBlock, `${label}: has a bass line`)
      }
    }
  }
}
assert.deepEqual(pianoEvents(layoutChords(sampleTune, cMajor, {}, 2), 'block'), chordEvents(layoutChords(sampleTune, cMajor, {}, 2)))

// Richer chords adds sevenths but never under a sung root a semitone away, and ends plainly.
const plain = layoutChords(sampleTune, cMajor, {}, 2)
const rich = layoutChords(sampleTune, cMajor, {}, 2, true)
assert.ok(plain.every((slot) => slot.chord.tones.length === 3), 'default harmony stays in triads for the sample')
assert.ok(rich.some((slot) => slot.chord.tones.length === 4), 'richer harmony uses a seventh')
assert.equal(rich.at(-1)!.chord.id, '0:maj')
assert.deepEqual(rich.map((slot) => slot.id), plain.map((slot) => slot.id), 'chord edits keep their slots')
for (const slot of rich) {
  if (slot.chord.quality !== 'maj7') continue
  const sung = sampleTune.filter((note) => note.startBeat < slot.startBeat + slot.durationBeats && note.startBeat + note.durationBeats > slot.startBeat)
  assert.ok(sung.every((note) => pitchClass(note.midi) !== slot.chord.root), `${slot.chord.symbol} under a sung root`)
}

// MIDI: piano alone stays a single track; with the melody it is two tracks on two channels.
const events = pianoEvents(plain, 'arpeggio')
const solo = encodePianoMidi(events, 96)
assert.deepEqual([solo[9], solo[11]], [0, 1])
const duet = encodePianoMidi(events, 96, sampleTune)
assert.deepEqual([duet[9], duet[11]], [1, 2])
const tracks = readTracks(duet)
assert.equal(tracks.length, 2)
assert.deepEqual(noteOns(tracks[0]), { channel: 0, count: events.length })
assert.deepEqual(noteOns(tracks[1]), { channel: 1, count: sampleTune.length })
console.log('ok accompaniment: 4 styles x 3 chord rhythms, chord tones, no restruck keys, sevenths, two-track MIDI')

function readTracks(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found: Uint8Array[] = []
  let cursor = 14
  while (cursor < bytes.length) {
    assert.equal(new TextDecoder().decode(bytes.slice(cursor, cursor + 4)), 'MTrk')
    const length = view.getUint32(cursor + 4)
    found.push(bytes.slice(cursor + 8, cursor + 8 + length))
    cursor += 8 + length
  }
  assert.equal(cursor, bytes.length)
  return found
}

function noteOns(track: Uint8Array): { channel: number; count: number } {
  let cursor = 0
  let count = 0
  let channel = -1
  let open = 0
  while (cursor < track.length) {
    while (track[cursor++] & 0x80) { /* delta time */ }
    const status = track[cursor++]
    if (status === 0xff) {
      const length = track[cursor + 1]
      cursor += 2 + length
    } else if ((status & 0xf0) === 0xc0) cursor += 1
    else {
      if ((status & 0xf0) === 0x90) { count++; open++; channel = status & 0x0f } else open--
      cursor += 2
    }
  }
  assert.equal(open, 0, 'every note is released')
  return { channel, count }
}
