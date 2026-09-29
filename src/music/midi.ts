import { voiceChord, type Chord } from './theory.ts'

export type ChordSlotLike = {
  startBeat: number
  durationBeats: number
  chord: Chord
}

export type PianoEvent = {
  midi: number
  startBeat: number
  durationBeats: number
  velocity: number
}

export function chordEvents(slots: ChordSlotLike[]): PianoEvent[] {
  let previous: number[] | null = null
  const events: PianoEvent[] = []
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]
    const next = slots[index + 1]
    let duration = slot.durationBeats
    if (next) duration = Math.min(duration, Math.max(0.25, next.startBeat - slot.startBeat - 0.06))
    const midis = voiceChord(slot.chord, previous)
    previous = midis
    for (const midi of midis) {
      events.push({ midi, startBeat: slot.startBeat, durationBeats: duration, velocity: 104 })
    }
  }
  return events
}

export function encodePianoMidi(events: PianoEvent[], bpm: number): Uint8Array {
  const ppq = 480
  const tempo = Math.round(60_000_000 / bpm)
  const title = [...new TextEncoder().encode('Piano')]
  const messages: { tick: number; data: number[] }[] = [
    { tick: 0, data: [0xff, 0x03, title.length, ...title] },
    { tick: 0, data: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] },
    { tick: 0, data: [0xc0, 0] },
  ]

  for (const event of events) {
    const start = Math.max(0, Math.round(event.startBeat * ppq))
    const end = Math.max(start + 1, Math.round((event.startBeat + event.durationBeats) * ppq))
    const midi = clamp(Math.round(event.midi), 0, 127)
    const velocity = clamp(Math.round(event.velocity), 1, 127)
    messages.push({ tick: start, data: [0x90, midi, velocity] })
    messages.push({ tick: end, data: [0x80, midi, 0] })
  }

  const lastTick = messages.reduce((max, message) => Math.max(max, message.tick), 0)
  messages.push({ tick: lastTick + ppq, data: [0xff, 0x2f, 0] })
  messages.sort((a, b) => a.tick - b.tick || statusOrder(a.data[0]) - statusOrder(b.data[0]))

  const track: number[] = []
  let cursor = 0
  for (const message of messages) {
    track.push(...variableLength(message.tick - cursor), ...message.data)
    cursor = message.tick
  }

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ]
  const length = track.length
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b,
    (length >> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]
  return new Uint8Array([...header, ...trackHeader, ...track])
}

function variableLength(value: number): number[] {
  let remaining = Math.max(0, value)
  const bytes = [remaining & 0x7f]
  remaining >>= 7
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80)
    remaining >>= 7
  }
  return bytes
}

function statusOrder(status: number): number {
  if (status === 0x80) return 0
  if (status === 0xff) return 1
  if (status === 0xc0) return 2
  return 3
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
