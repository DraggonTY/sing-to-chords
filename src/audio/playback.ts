import { pianoEvents, type PianoStyle } from '../music/accompany.ts'
import type { ChordSlotLike } from '../music/midi.ts'
import type { RawNote } from '../music/theory.ts'
import type { PlayableNote } from './session.ts'

/** Keep the diagnostic audition independent of arrangement edits and newer takes. */
export function makePlaybackPlan(
  song: { raw: RawNote[]; recordedBpm: number },
  arrangement: { notes: RawNote[]; chords: ChordSlotLike[]; bpm: number; hearMelody: boolean; withClick: boolean; style?: PianoStyle },
  melodyOnly: boolean,
): { notes: PlayableNote[]; bpm: number; withClick: boolean } {
  const melody = melodyOnly ? song.raw : arrangement.hearMelody ? arrangement.notes : []
  const notes: PlayableNote[] = melodyOnly
    ? []
    : pianoEvents(arrangement.chords, arrangement.style).map((note) => ({ ...note, velocity: Math.round(note.velocity * 96 / 104) }))
  notes.push(...melody.map((note) => ({
    midi: note.midi,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: 72,
  })))
  return {
    notes,
    bpm: melodyOnly ? song.recordedBpm : arrangement.bpm,
    withClick: melodyOnly ? false : arrangement.withClick,
  }
}
