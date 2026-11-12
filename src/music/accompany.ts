import { chordEvents, type ChordSlotLike, type PianoEvent } from './midi.ts'
import { voiceChord } from './theory.ts'

export type PianoStyle = 'block' | 'bass' | 'broken' | 'arpeggio'

export const PIANO_STYLES: readonly (readonly [PianoStyle, string])[] = [
  ['block', 'Block'],
  ['bass', 'Bass + chord'],
  ['broken', 'Broken'],
  ['arpeggio', 'Arpeggio'],
]

const STEP = 0.5
const GAP = 0.06

/**
 * Turn the chord progression into a playable piano part.
 * Every pattern keeps the voice-led right hand from `voiceChord`, so switching
 * styles changes the rhythm and register, not the harmony.
 */
export function pianoEvents(slots: ChordSlotLike[], style: PianoStyle = 'block'): PianoEvent[] {
  if (style === 'block') return chordEvents(slots)
  const events: PianoEvent[] = []
  let previous: number[] | null = null
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]
    const next = slots[index + 1]
    let length = slot.durationBeats
    if (next) length = Math.min(length, Math.max(0.25, next.startBeat - slot.startBeat))
    const hand = voiceChord(slot.chord, previous)
    previous = hand
    const bass = bassNote(slot.chord.root, hand[0])
    const push = (midi: number, offset: number, duration: number, velocity: number) => {
      const room = length - offset - (next ? GAP : 0)
      if (room < 0.12) return
      events.push({ midi, startBeat: slot.startBeat + offset, durationBeats: Math.min(duration, room), velocity })
    }

    if (style === 'bass') {
      // Left hand holds the root; the right hand answers on the following beats.
      push(bass, 0, length, 100)
      if (length <= 1 + 1e-6) {
        for (const midi of hand) push(midi, 0, length, 84)
      } else {
        for (let beat = 1; beat < length - 0.12; beat++) {
          for (const midi of hand) push(midi, beat, 1 - GAP, beat % 2 ? 86 : 78)
        }
        // A fifth in the bass keeps a whole bar from sitting on one note.
        if (length >= 4 - 1e-6) push(bass + 7 > 55 ? bass - 5 : bass + 7, 2, length - 2, 88)
      }
      continue
    }

    if (style === 'broken') {
      // Alberti-style figure: low, high, middle, high.
      const low = hand[0]
      const high = hand[hand.length - 1]
      const middle = hand[1]
      const figure = [low, high, middle, high]
      push(bass, 0, length, 92)
      for (let step = 0; step * STEP < length - 0.12; step++) {
        push(figure[step % figure.length], step * STEP, STEP - 0.03, step % 4 === 0 ? 88 : 72)
      }
      continue
    }

    // Arpeggio: climb from the bass through the chord and let each note ring.
    const climb = [bass, ...hand]
    const ladder = [...climb, ...climb.slice(1, -1).reverse()]
    for (let step = 0; step * STEP < length - 0.12; step++) {
      const offset = step * STEP
      push(ladder[step % ladder.length], offset, length - offset, step === 0 ? 96 : 76)
    }
  }
  return separateRepeats(events)
}

/** A key cannot be struck again while it is still down: end the earlier note first. */
function separateRepeats(events: PianoEvent[]): PianoEvent[] {
  const ordered = events.slice().sort((a, b) => a.startBeat - b.startBeat)
  const sounding = new Map<number, PianoEvent>()
  const kept: PianoEvent[] = []
  for (const event of ordered) {
    const earlier = sounding.get(event.midi)
    if (earlier && earlier.startBeat + earlier.durationBeats > event.startBeat - 0.02) {
      // Two hands landing on one key at the same instant is a single note.
      if (event.startBeat - earlier.startBeat < 0.05) {
        earlier.durationBeats = Math.max(earlier.durationBeats, event.durationBeats)
        earlier.velocity = Math.max(earlier.velocity, event.velocity)
        continue
      }
      earlier.durationBeats = event.startBeat - earlier.startBeat - 0.02
    }
    const copy = { ...event }
    sounding.set(copy.midi, copy)
    kept.push(copy)
  }
  return kept
}

/** Root below the right hand, kept in a clear (not muddy) bass register. */
function bassNote(root: number, lowestHand: number): number {
  let midi = 36 + (((root % 12) + 12) % 12)
  while (midi + 12 < lowestHand && midi + 12 <= 47) midi += 12
  if (midi >= lowestHand) midi -= 12
  return midi
}
