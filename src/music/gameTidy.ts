import type { GameNote } from './game.ts'
import type { RawNote } from './theory.ts'
import model from './gameTidy.model.json' with { type: 'json' }

/**
 * GAME writes a singer's scoop into a note as a short extra note below it, and
 * sometimes splits one held note in two. This stage decides, for every boundary
 * between two touching notes, whether a new note really starts there.
 *
 * The decision comes from small networks and boosted trees trained on the Children's Song Dataset's
 * development songs (scripts/benchmark-csd.ts): the inputs are GAME's own
 * features around the boundary (what the sound does there) and the two notes'
 * lengths and pitches. A boundary judged false is removed and the pieces become
 * one note, which keeps the earlier start and the pitch of its longest piece.
 */
type Layer = { weights: number[][]; bias: number[] }
/** A tree is a list of nodes: a leaf is `[value]`, a branch is `[input, threshold, left, right]`. */
type Tree = number[][]
/**
 * Several networks trained from different starting points, and a forest of
 * boosted trees over the same inputs. The answer is the average of the networks'
 * mean and the forest; the two make different mistakes.
 */
export type TidyModel = { threshold: number; mean: number[]; scale: number[]; members: Layer[][]; forest: { base: number; trees: Tree[] } }
const MODEL = model as unknown as TidyModel
/** Inputs that follow GAME's features: the two notes and their neighbours. */
const NOTE_INPUTS = 15

/**
 * The clean-up trained for the GAME model that produced `notes`. GAME's standard model and its
 * larger one have features of different widths, and each has its own clean-up weights; the
 * larger model's are loaded only when that model is in use.
 */
export async function tidyModelFor(notes: GameNote[]): Promise<TidyModel> {
  const inputs = (notes[0]?.context.length ?? MODEL.mean.length - NOTE_INPUTS) + NOTE_INPUTS
  if (inputs === MODEL.mean.length) return MODEL
  const large = (await import('./gameTidy.large.ts')).default as unknown as TidyModel
  if (inputs !== large.mean.length) throw new Error('No clean-up model matches this GAME model.')
  return large
}

/** Two notes touch when the gap between them is shorter than this (seconds). */
const TOUCHING = 0.03

/** GAME's notes as the app's notes, in seconds (that is, at 60 BPM), with false boundaries removed. */
export function tidyGameNotes(notes: GameNote[], trained: TidyModel = MODEL): RawNote[] {
  type Piece = { start: number; end: number; pitch: number }
  const merged: Array<{ start: number; end: number; pieces: Piece[] }> = []
  notes.forEach((note, index) => {
    const previous = notes[index - 1]
    const joins = previous !== undefined && note.start - previous.end <= TOUCHING && startsNewNote(notes, index, trained) < trained.threshold
    if (joins) {
      const whole = merged[merged.length - 1]
      whole.end = note.end
      whole.pieces.push(note)
    } else merged.push({ start: note.start, end: note.end, pieces: [note] })
  })
  return merged.map((note, index) => {
    const longest = note.pieces.reduce((best, piece) => piece.end - piece.start > best.end - best.start ? piece : best)
    return {
      id: `g${index}-${Math.round(note.start * 1000)}`,
      midi: Math.round(longest.pitch),
      sungPitch: Math.round(longest.pitch * 1000) / 1000,
      startBeat: Math.round(note.start * 1000) / 1000,
      durationBeats: Math.round((note.end - note.start) * 1000) / 1000,
    }
  }).filter((note) => note.durationBeats > 0)
}

/** Probability that a new note really starts at note `index` (which touches the note before it). */
export function startsNewNote(notes: GameNote[], index: number, trained: TidyModel = MODEL): number {
  const features = boundaryFeatures(notes, index)
  const inputs = features.map((value, at) => (value - trained.mean[at]) / trained.scale[at])
  let total = 0
  for (const layers of trained.members) {
    let values = inputs
    layers.forEach((layer, depth) => {
      const last = depth === layers.length - 1
      values = layer.bias.map((bias, unit) => {
        let sum = bias
        const weights = layer.weights[unit]
        for (let at = 0; at < values.length; at++) sum += weights[at] * values[at]
        return last ? sum : Math.max(0, sum)
      })
    })
    total += 1 / (1 + Math.exp(-values[0]))
  }
  let margin = trained.forest.base
  for (const tree of trained.forest.trees) {
    let node = tree[0]
    while (node.length > 1) node = tree[features[node[0]] <= node[1] ? node[2] : node[3]]
    margin += node[0]
  }
  return (total / trained.members.length + 1 / (1 + Math.exp(-margin))) / 2
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** GAME's features around the boundary, then what the two notes and their neighbours look like. */
export function boundaryFeatures(notes: GameNote[], index: number): number[] {
  const before = notes[index - 1]
  const after = notes[index]
  const earlier = notes[index - 2]
  const later = notes[index + 1]
  const beforeLength = before.end - before.start
  const afterLength = after.end - after.start
  const step = after.pitch - before.pitch
  return [
    ...after.context,
    beforeLength,
    afterLength,
    Math.log(beforeLength + 0.01),
    Math.log(afterLength + 0.01),
    beforeLength / (beforeLength + afterLength),
    clamp(step, -8, 8),
    Math.min(Math.abs(step), 8),
    Math.abs(before.pitch - Math.round(before.pitch)),
    Math.abs(after.pitch - Math.round(after.pitch)),
    earlier ? earlier.end - earlier.start : 1,
    earlier ? Math.min(1, before.start - earlier.end) : 1,
    earlier ? clamp(earlier.pitch - before.pitch, -8, 8) : 0,
    later ? later.end - later.start : 1,
    later ? Math.min(1, later.start - after.end) : 1,
    later ? clamp(later.pitch - after.pitch, -8, 8) : 0,
  ]
}
