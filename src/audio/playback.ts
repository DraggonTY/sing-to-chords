import { chordEvents, type ChordSlotLike } from '../music/midi.ts'
import type { RawNote } from '../music/theory.ts'
import type { PlayableNote } from './session.ts'

/** Keep the diagnostic audition independent of arrangement edits and newer takes. */
export function makePlaybackPlan(
  song: { raw: RawNote[]; recordedBpm: number },
  arrangement: { notes: RawNote[]; chords: ChordSlotLike[]; bpm: number; hearMelody: boolean; withClick: boolean },
  melodyOnly: boolean,
): { notes: PlayableNote[]; bpm: number; withClick: boolean } {
  const melody = melodyOnly ? song.raw : arrangement.hearMelody ? arrangement.notes : []
  const notes: PlayableNote[] = melodyOnly
    ? []
    : chordEvents(arrangement.chords).map((note) => ({ ...note, velocity: 96 }))
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
