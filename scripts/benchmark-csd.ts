/**
 * Score-level accuracy on real singing: the Children's Song Dataset (CSD,
 * Choi et al. 2020; CC BY-NC-SA 4.0; https://zenodo.org/records/4916302).
 * One professional singer, 50 English songs in two keys each, sung at a known
 * tempo, with the score's notes labelled in time. The audio is not bundled.
 *
 *   node scripts/benchmark-csd.ts --dataset /path/to/csd [--split dev|holdout]
 *        [--notes notes.json] [--quantize 16|8|auto] [--verbose]
 *
 * The dataset directory holds `wav/en001a.wav …` and `CSD/english/{csv,metadata.json}`.
 * `--game <notes.json>` scores the GAME engine: the file holds GAME's notes per
 * recording as written by the app's own pipeline (src/music/game.ts run under
 * Node), with each note's encoder context in `<notes.json>.feat/<name>.f32`;
 * they go through the app's clean-up (src/music/gameTidy.ts) unless `--no-tidy`.
 * `--notes` scores notes produced elsewhere (a JSON object: file name -> notes
 * in seconds as {midi, sungPitch, startBeat, durationBeats} at 60 BPM) instead
 * of the built-in engine.
 *
 * WHERE A NOTE STARTS. The labels mark syllable boundaries, drawn by hand and
 * including consonants ("s-weet", "str-ains"). With `--voicing <dir>` (per-file
 * SwiftF0 output, {conf} every 16 ms) a note that opens unvoiced is taken to
 * start at its first voiced moment; all others start at their label.
 *
 * PRIMARY METRIC ("notes right"), fixed before any tuning: a score note is
 * right when a detected note has the same semitone and starts within 100 ms of
 * it, one detection per note. Reported as F1 with precision and recall over all
 * notes of the split. The usual 50 ms window is reported beside it but is not
 * the target: in these labels a syllable boundary sits up to about 90 ms from
 * where the pitch changes on the beat (for "sing-ing" in en002a the label is
 * at 8.02 s and the beat, where the pitch moves, at 8.11 s), so 50 ms measures
 * agreement with the annotator's hand more than whether the note is right.
 * Detected notes are the app's (transcribe, then tuning and key correction),
 * before Quantize; a whole take may be scored one semitone up or down (the app
 * names a between-keys voice in the plainer key), and the take's median timing
 * offset is removed, as the app's lateness correction does.
 *
 * Also reported: the 50 ms form, and the app-level view after Quantize 16ths
 * (same pitch on the same sixteenth as the labelled onset rounds to).
 *
 * Split by song, fixed before any result was seen: songs 1-30 are the
 * development set (all tuning happens there), songs 31-50 are held out.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { analysisFromNotes, applyQuantize, type QuantizeDivision } from '../src/music/analyze.ts'
import { extractSingingNotes } from '../src/music/pitch.ts'
import type { GameNote } from '../src/music/game.ts'
import { tidyGameNotes } from '../src/music/gameTidy.ts'
import type { RawNote } from '../src/music/theory.ts'

const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const dataset = option('--dataset')
if (!dataset) throw new Error('Provide --dataset pointing at the CSD directory.')
const split = option('--split', 'dev')!
const quantize = option('--quantize', '16')!
const verbose = args.includes('--verbose')
const notesFile = option('--notes')
const voicingDir = option('--voicing')
const gameFile = option('--game')
const supplied: Record<string, RawNote[]> | null = notesFile ?? gameFile ? JSON.parse(readFileSync((notesFile ?? gameFile)!, 'utf8')) : null
const metadata: Record<string, { songname: string; tempo: number; time_signature: string }> = JSON.parse(readFileSync(path.join(dataset, 'CSD/english/metadata.json'), 'utf8'))

function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(file)
  let channels = 1, sampleRate = 0
  let data: Buffer | undefined
  for (let cursor = 12; cursor + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(cursor + 4)
    const name = buffer.toString('ascii', cursor, cursor + 4)
    if (name === 'fmt ') { channels = buffer.readUInt16LE(cursor + 10); sampleRate = buffer.readUInt32LE(cursor + 12) }
    if (name === 'data') data = buffer.subarray(cursor + 8, cursor + 8 + size)
    cursor += 8 + size + size % 2
  }
  if (!data) throw new Error(`No audio in ${file}`)
  const count = Math.floor(data.length / 2 / channels)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) sum += data.readInt16LE((index * channels + channel) * 2)
    samples[index] = sum / channels / 32768
  }
  return { samples, sampleRate }
}

type Tally = { reference: number; detected: number; right: number }
const empty = (): Tally => ({ reference: 0, detected: 0, right: 0 })
const grid = empty(), within50 = empty(), within100 = empty()
const reasons: Record<string, number> = {}
const perTake: Array<{ name: string; f1: number; shift: number }> = []
const perTake50 = new Map<string, number>()
let takes = 0, shifted = 0

/** One-to-one matching of reference and detected notes under a predicate (greedy in time order is exact for these criteria per cell; augmenting paths for tolerances). */
function match<R, D>(reference: R[], detected: D[], ok: (r: R, d: D) => boolean): number {
  const adjacency = reference.map((r) => detected.flatMap((d, index) => ok(r, d) ? [index] : []))
  const owner = new Array<number>(detected.length).fill(-1)
  const visit = (r: number, seen: Set<number>): boolean => {
    for (const d of adjacency[r]) {
      if (seen.has(d)) continue
      seen.add(d)
      if (owner[d] < 0 || visit(owner[d], seen)) { owner[d] = r; return true }
    }
    return false
  }
  let matched = 0
  for (let r = 0; r < reference.length; r++) if (visit(r, new Set())) matched++
  return matched
}

for (const name of Object.keys(metadata).sort()) {
  const song = Number(name.slice(2, 5))
  if ((split === 'dev') !== (song <= 30)) continue
  const wav = path.join(dataset, 'wav', `${name}.wav`)
  if (!supplied && !existsSync(wav)) continue
  if (supplied && !supplied[`${name}.wav`]) continue
  const bpm = metadata[name].tempo
  const rows = readFileSync(path.join(dataset, 'CSD/english/csv', `${name}.csv`), 'utf8').trim().split(/\r?\n/).slice(1).map((row) => {
    const [start, end, pitch] = row.split(',')
    return { start: Number(start), end: Number(end), midi: Number(pitch) }
  })
  if (voicingDir) {
    // Move each labelled syllable start to the first voiced moment of its note.
    const { conf } = JSON.parse(readFileSync(path.join(voicingDir, `${name}.json`), 'utf8')) as { conf: number[] }
    const voiced = (frame: number) => (conf[frame] ?? 0) >= 0.5
    for (const row of rows) {
      const first = Math.round(row.start / 0.016)
      if (voiced(first) || voiced(first + 1)) continue
      const limit = Math.round(Math.min(row.end, row.start + 0.3) / 0.016)
      for (let frame = first + 1; frame <= limit; frame++) {
        if (voiced(frame) && voiced(frame + 1)) { row.start = frame * 0.016; break }
      }
    }
  }
  // Score positions: onsets on the sixteenth grid, after the take's shared offset.
  const residuals = rows.map((row) => { const beat = row.start * bpm / 60; return beat - Math.round(beat * 4) / 4 }).sort((a, b) => a - b)
  const offset = residuals[Math.floor(residuals.length / 2)]
  const reference = rows.map((row) => ({ midi: row.midi, cell: Math.round((row.start * bpm / 60 - offset) * 4), start: row.start }))

  let seconds: RawNote[]
  if (supplied && gameFile) {
    const raw = supplied[`${name}.wav`]
    const bytes = readFileSync(path.join(`${gameFile}.feat`, `${name}.f32`))
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    const width = raw.length ? all.length / raw.length : 0
    const heard: GameNote[] = raw.map((note, index) => ({ start: note.startBeat, end: note.startBeat + note.durationBeats, pitch: note.sungPitch ?? note.midi, context: all.subarray(index * width, (index + 1) * width) }))
    seconds = args.includes('--no-tidy') ? raw : tidyGameNotes(heard)
  } else if (supplied) seconds = supplied[`${name}.wav`]
  else { const { samples, sampleRate } = readWav(wav); seconds = extractSingingNotes(samples, sampleRate, 60) }
  const inBeats = seconds.map((note) => ({ ...note, startBeat: note.startBeat * bpm / 60, durationBeats: note.durationBeats * bpm / 60 }))
  const analysis = analysisFromNotes(inBeats)
  let division: QuantizeDivision = quantize === '8' ? '8' : '16'
  const placed = applyQuantize(analysis.notes, division).map((note) => ({ midi: note.midi, cell: Math.round(note.startBeat * 4) }))

  // The app's quantizer removes the take's lateness against the metre; allow the same
  // whole-take alignment to the score grid in whole sixteenths (a constant, not per note).
  const score = (shift: number, move: number) => match(reference, placed, (r, d) => d.midi + shift === r.midi && d.cell + move === r.cell)
  let best = { shift: 0, move: 0, right: -1 }
  for (const shift of [0, 1, -1]) for (const move of [0, 1, -1, 2, -2]) { const right = score(shift, move); if (right > best.right) best = { shift, move, right } }
  takes++
  if (best.shift) shifted++
  grid.reference += reference.length; grid.detected += placed.length; grid.right += best.right
  const takeF1 = 2 * best.right / (reference.length + placed.length)
  perTake.push({ name, f1: takeF1, shift: best.shift })

  // Why were notes missed? (diagnosis only)
  const used = new Set<number>()
  for (const r of reference) {
    const exact = placed.findIndex((d, index) => !used.has(index) && d.midi + best.shift === r.midi && d.cell + best.move === r.cell)
    if (exact >= 0) { used.add(exact); continue }
    const sameCell = placed.find((d) => d.cell + best.move === r.cell)
    const near = placed.find((d) => d.midi + best.shift === r.midi && Math.abs(d.cell + best.move - r.cell) === 1)
    const reason = sameCell ? (Math.abs(sameCell.midi + best.shift - r.midi) === 1 ? 'wrong pitch by a semitone' : Math.abs(sameCell.midi + best.shift - r.midi) === 12 ? 'wrong octave' : 'wrong pitch by more') : near ? 'right pitch, one sixteenth off' : 'missing'
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }

  // Standard transcription metric on the unquantized notes.
  const raw = analysis.notes.map((note) => ({ midi: note.midi + best.shift, start: note.startBeat * 60 / bpm }))
  const lags = raw.flatMap((d) => { const r = rows.reduce((a, b) => Math.abs(b.start - d.start) < Math.abs(a.start - d.start) ? b : a); return Math.abs(r.start - d.start) < 0.15 ? [d.start - r.start] : [] }).sort((a, b) => a - b)
  const lag = lags.length ? lags[Math.floor(lags.length / 2)] : 0
  for (const [tally, tolerance] of [[within50, 0.05], [within100, 0.1]] as const) {
    const right = match(rows, raw, (r, d) => d.midi === r.midi && Math.abs(d.start - lag - r.start) <= tolerance)
    tally.reference += rows.length; tally.detected += raw.length; tally.right += right
    if (tolerance === 0.1) perTake50.set(name, 2 * right / (rows.length + raw.length))
  }
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`
const line = (label: string, tally: Tally) => {
  const precision = tally.right / Math.max(1, tally.detected), recall = tally.right / Math.max(1, tally.reference)
  return `${label.padEnd(44)} F1 ${percent(2 * tally.right / Math.max(1, tally.detected + tally.reference))}   precision ${percent(precision)}   recall ${percent(recall)}`
}
console.log(`CSD ${split}: ${takes} recordings, ${grid.reference} score notes${gameFile ? `, GAME${args.includes('--no-tidy') ? ' without clean-up' : ' with clean-up'}` : supplied ? `, notes from ${path.basename(notesFile!)}` : ', built-in engine'}, quantize ${quantize}`)
console.log(line('NOTES RIGHT (same semitone, within 100 ms)', within100))
console.log(line('same semitone, within 50 ms', within50))
console.log(line('after Quantize: same pitch, same sixteenth', grid))
console.log(`  misses: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason} ${count}`).join('; ')}; extra or misplaced detections ${grid.detected - grid.right}`)
console.log(`  takes scored a semitone away: ${shifted}/${takes}`)
if (verbose) console.log([...perTake50].sort((a, b) => a[1] - b[1]).slice(0, 14).map(([name, f1]) => `  ${name} ${metadata[name].songname} (${metadata[name].tempo} BPM, ${metadata[name].time_signature}) ${percent(f1)}`).join('\n'))
