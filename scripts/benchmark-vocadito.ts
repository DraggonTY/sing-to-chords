/**
 * Real solo-vocal note benchmark. Data is downloaded separately from
 * https://zenodo.org/records/5578807 (CC BY 4.0; 58.5 MB).
 *
 * node scripts/benchmark-vocadito.ts --dataset /path/to/vocadito --split dev
 * Optional: --engine /path/to/frozen-pitch.ts --output /path/to/report.json
 * Keep holdout singers unused until the candidate implementation is frozen.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Note = { start: number; end: number; pitch: number }
type MatchScore = { matched: number; estimated: number; reference: number; unmatchedEstimates: number; unmatchedReferences: number; precision: number; recall: number; f1: number }
type Scores = { note: MatchScore; fullNote: MatchScore; onset: MatchScore }
type Report = { track: number; singer: string; seconds: number; estimatedNotes: number; A1: Scores; A2: Scores }
type Engine = { extractSingingNotes: (audio: Float32Array, rate: number, bpm: number) => Array<{ midi: number; startBeat: number; durationBeats: number }> }
const args = process.argv.slice(2)
function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return args[index + 1]
}
const dataset = option('--dataset')
if (!dataset) throw new Error('Provide --dataset pointing to the extracted vocadito v3 directory (Audio/, Annotations/, vocadito_metadata.csv).')
const split = option('--split', 'dev')
if (split !== 'dev' && split !== 'holdout') throw new Error('--split must be dev or holdout.')
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const enginePath = path.resolve(option('--engine', path.join(scriptDirectory, '../src/music/pitch.ts'))!)
const engine: Engine = await import(pathToFileURL(enginePath).href)
if (typeof engine.extractSingingNotes !== 'function') throw new Error('Engine must export extractSingingNotes(audio, sampleRate, bpm).')
const source = readFileSync(enginePath)
function fingerprintSources(entry: string) {
  const files = new Map<string, string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    const text = readFileSync(file, 'utf8')
    files.set(file, createHash('sha256').update(text).digest('hex'))
    // Include local imports/re-exports (including types where available), so a
    // changed segmenter cannot hide behind an unchanged pitch entry point.
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1])
      const resolved = [target, `${target}.ts`, `${target}.js`].find((candidate) => existsSync(candidate))
      if (resolved) visit(resolved)
    }
  }
  visit(entry)
  const sources = [...files].sort(([left], [right]) => left.localeCompare(right)).map(([file, sha256]) => ({ file: path.relative(path.dirname(entry), file), sha256 }))
  return { sources, sha256: createHash('sha256').update(JSON.stringify(sources)).digest('hex') }
}
const sourceFingerprint = fingerprintSources(enginePath)
const metadata = readFileSync(path.join(dataset, 'vocadito_metadata.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((row) => {
  const [track, singer] = row.split(',')
  return { track: Number(track), singer }
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const singers = [...new Set(metadata.map((row) => row.singer))].sort((a, b) => hash(`vocadito-v3-segmentation-v1:${a}`).localeCompare(hash(`vocadito-v3-segmentation-v1:${b}`)))
const selectedSingers = new Set(singers.filter((_, index) => index % 2 === (split === 'dev' ? 0 : 1)))
const selected = metadata.filter((row) => selectedSingers.has(row.singer))

function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(file)
  let codec = 0, channels = 0, bits = 0, sampleRate = 0
  let data: Buffer | undefined
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF', 'Expected RIFF WAV')
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE', 'Expected RIFF WAV')
  for (let cursor = 12; cursor + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(cursor + 4)
    const name = buffer.toString('ascii', cursor, cursor + 4)
    if (name === 'fmt ') {
      codec = buffer.readUInt16LE(cursor + 8)
      channels = buffer.readUInt16LE(cursor + 10)
      sampleRate = buffer.readUInt32LE(cursor + 12)
      bits = buffer.readUInt16LE(cursor + 22)
    }
    if (name === 'data') data = buffer.subarray(cursor + 8, cursor + 8 + size)
    cursor += 8 + size + size % 2
  }
  if (codec !== 1 || channels !== 1 || bits !== 16 || !data || sampleRate <= 0) throw new Error(`Expected mono PCM16 WAV: ${file}`)
  const samples = Float32Array.from({ length: data.length / 2 }, (_, index) => data!.readInt16LE(index * 2) / 32768)
  return { samples, sampleRate }
}

function referenceNotes(track: number, annotator: number): Note[] {
  return readFileSync(path.join(dataset!, 'Annotations', 'Notes', `vocadito_${track}_notesA${annotator}.csv`), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map((row) => {
      const [start, hz, duration] = row.split(',').map(Number)
      return { start, end: start + duration, pitch: 69 + 12 * Math.log2(hz / 440) }
    })
}

// Maximum-cardinality bipartite matching (augmenting paths), never greedy.
// Criteria follow mir_eval: onset ±50 ms, pitch ±50 cents; optional offsets
// within max(50 ms, 20% of reference duration). All thresholds are inclusive.
function matchNotes(reference: Note[], estimate: Note[], mode: 'note' | 'onset' = 'note', offsets = false): MatchScore {
  const adjacency = estimate.map((est) => reference.flatMap((ref, index) => {
    const onsetDistance = Math.round(Math.abs(est.start - ref.start) * 1e4) / 1e4
    const offsetDistance = Math.round(Math.abs(est.end - ref.end) * 1e4) / 1e4
    return onsetDistance <= 0.05 && (mode === 'onset' || Math.abs(est.pitch - ref.pitch) <= 0.5)
      && (!offsets || offsetDistance <= Math.max(0.05, (ref.end - ref.start) * 0.2)) ? [index] : []
  }))
  const assigned = new Array<number>(reference.length).fill(-1)
  function visit(estimateIndex: number, seen: Set<number>): boolean {
    for (const referenceIndex of adjacency[estimateIndex]) {
      if (seen.has(referenceIndex)) continue
      seen.add(referenceIndex)
      if (assigned[referenceIndex] < 0 || visit(assigned[referenceIndex], seen)) {
        assigned[referenceIndex] = estimateIndex
        return true
      }
    }
    return false
  }
  let matched = 0
  for (let index = 0; index < estimate.length; index++) if (visit(index, new Set())) matched++
  return {
    matched, estimated: estimate.length, reference: reference.length,
    unmatchedEstimates: estimate.length - matched, unmatchedReferences: reference.length - matched,
    precision: matched / Math.max(1, estimate.length), recall: matched / Math.max(1, reference.length),
    f1: 2 * matched / Math.max(1, estimate.length + reference.length),
  }
}

// This graph requires reassigning the first estimate to obtain two matches.
const matcherFixture = (start: number): Note => ({ start, end: start + 0.1, pitch: 60 })
assert.equal(matchNotes([matcherFixture(0), matcherFixture(0.06)], [matcherFixture(0.02), matcherFixture(0)]).matched, 2)
assert.equal(matchNotes([matcherFixture(0)], [{ ...matcherFixture(0), pitch: 61 }]).matched, 0)
assert.equal(matchNotes([matcherFixture(0)], [{ ...matcherFixture(0), pitch: 61 }], 'onset').matched, 1)

function scores(reference: Note[], estimate: Note[]): Scores {
  return { note: matchNotes(reference, estimate), fullNote: matchNotes(reference, estimate, 'note', true), onset: matchNotes(reference, estimate, 'onset') }
}

const reports: Report[] = []
for (const { track, singer } of selected) {
  const { samples, sampleRate } = readWav(path.join(dataset, 'Audio', `vocadito_${track}.wav`))
  // At 60 BPM, the public API's beats equal seconds. No UI quantization is used.
  const notes = engine.extractSingingNotes(samples, sampleRate, 60).map((note) => ({ start: note.startBeat, end: note.startBeat + note.durationBeats, pitch: note.midi }))
  const report: Report = { track, singer, seconds: samples.length / sampleRate, estimatedNotes: notes.length, A1: scores(referenceNotes(track, 1), notes), A2: scores(referenceNotes(track, 2), notes) }
  reports.push(report)
  console.error(`vocadito_${track}: notes ${notes.length}/${report.A2.note.reference} A2; note F1 ${report.A2.note.f1.toFixed(3)}; onset F1 ${report.A2.onset.f1.toFixed(3)}`)
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
function aggregate(annotator: 'A1' | 'A2') {
  return Object.fromEntries((['note', 'fullNote', 'onset'] as const).map((metric) => {
    const entries = reports.map((report) => report[annotator][metric])
    const matched = entries.reduce((sum, entry) => sum + entry.matched, 0)
    const reference = entries.reduce((sum, entry) => sum + entry.reference, 0)
    const estimated = entries.reduce((sum, entry) => sum + entry.estimated, 0)
    return [metric, {
      matched, estimated, reference, unmatchedEstimates: estimated - matched, unmatchedReferences: reference - matched,
      macro: { precision: mean(entries.map((entry) => entry.precision)), recall: mean(entries.map((entry) => entry.recall)), f1: mean(entries.map((entry) => entry.f1)) },
      micro: { precision: matched / Math.max(1, estimated), recall: matched / Math.max(1, reference), f1: 2 * matched / Math.max(1, estimated + reference) },
    }]
  }))
}
const result = {
  dataset: 'vocadito v3', source: 'https://zenodo.org/records/5578807', license: 'CC-BY-4.0',
  engineFile: enginePath, engineFileSHA256: createHash('sha256').update(source).digest('hex'),
  sourceFingerprint,
  split, splitRule: 'Sort unique singer IDs by SHA256(vocadito-v3-segmentation-v1:<singer>); even indexes dev, odd indexes holdout.',
  singers: [...selectedSingers].sort(), trackCount: reports.length,
  tolerances: { onsetSeconds: 0.05, pitchCents: 50, offsetMinimumSeconds: 0.05, offsetDurationRatio: 0.2 },
  A1: aggregate('A1'), A2: aggregate('A2'), tracks: reports,
}
const output = option('--output')
if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ split, tracks: reports.length, A1: result.A1, A2: result.A2 }, null, 2))
