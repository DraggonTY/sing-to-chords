import { checkRecording, prepareAudio } from './pitch.ts'

/**
 * GAME (openvpi, MIT): a singing-voice-to-score model. Its encoder turns audio
 * into features, its segmenter finds note boundaries by iterative refinement,
 * and its estimator gives each note a pitch. This module runs the published
 * ONNX graphs; the runtime (browser or Node) is injected.
 *
 * https://github.com/openvpi/GAME (workflow: ONNX.md)
 */
export type GameTensor = { type: 'float32' | 'int64' | 'bool'; data: Float32Array | BigInt64Array | Uint8Array; dims: number[] }
export type GameOutput = { data: ArrayLike<number> | ArrayLike<bigint>; dims: readonly number[] }
export type GameModule = 'encoder' | 'segmenter' | 'estimator' | 'dur2bd' | 'bd2dur'
export type GameRuntime = (module: GameModule, feeds: Record<string, GameTensor | GameOutput>) => Promise<Record<string, GameOutput>>

export type GameNote = {
  /** Seconds from the start of the recording. */
  start: number
  end: number
  /** Fractional MIDI pitch. */
  pitch: number
  /** The encoder's features around the note's start, pooled over five spans (5 x C values). */
  context: Float32Array
}

const MODEL_RATE = 44100
const FRAME = 0.01
const STEPS = 8
const BOUNDARY_THRESHOLD = 0.2
const PRESENCE_THRESHOLD = 0.2
const BOUNDARY_RADIUS = 2n
/**
 * The lyric languages GAME was trained on. The segmenter finds syllable boundaries
 * better when told the language; `other` leaves it unset. For a language it was not
 * trained on, the nearest in sound works best (Japanese for Korean, measured on CSD).
 */
export const GAME_LANGUAGES = { other: 0n, en: 1n, ja: 2n, yue: 3n, zh: 4n } as const
export type GameLanguage = keyof typeof GAME_LANGUAGES
// Frames before and after a boundary that describe what changes there.
const SPANS: readonly (readonly [number, number])[] = [[-16, -8], [-8, -3], [-3, 3], [3, 8], [8, 16]]
export const GAME_CONTEXT_SPANS = SPANS.length

const scalar = (type: 'float32' | 'int64', value: number | bigint): GameTensor =>
  type === 'float32' ? { type, data: new Float32Array([value as number]), dims: [] } : { type, data: new BigInt64Array([value as bigint]), dims: [] }

/** Transcribe a recording into GAME's notes, in seconds. `onProgress` receives 0..1. */
export async function gameNotes(
  samples: Float32Array,
  sampleRate: number,
  run: GameRuntime,
  onProgress?: (done: number) => void,
  language: GameLanguage = 'en',
): Promise<GameNote[]> {
  if (!checkRecording(samples, sampleRate, 60)) return []
  const audio = prepareAudio(samples, sampleRate, MODEL_RATE)
  const notes: GameNote[] = []
  const pieces = chunks(audio)
  for (let index = 0; index < pieces.length; index++) {
    const [from, to] = pieces[index]
    for (const note of await transcribeChunk(audio.slice(from, to), run, GAME_LANGUAGES[language])) {
      notes.push({ ...note, start: note.start + from / MODEL_RATE, end: note.end + from / MODEL_RATE })
    }
    onProgress?.((index + 1) / pieces.length)
  }
  return notes
}

export type GameFeatures = {
  /** Number of 10 ms frames. */
  frames: number
  /** Values per frame in each of the two feature streams. */
  width: number
  /** The encoder's segmentation features, `frames * width` values, zero where nothing was encoded. */
  segmentation: Float32Array
  /** The encoder's pitch-estimation features, the same shape. */
  estimation: Float32Array
}

/** Run only GAME's encoder: its two feature streams on one 10 ms clock for the whole recording. */
export async function gameFeatures(
  samples: Float32Array,
  sampleRate: number,
  run: GameRuntime,
  onProgress?: (done: number) => void,
): Promise<GameFeatures | null> {
  if (!checkRecording(samples, sampleRate, 60)) return null
  const audio = prepareAudio(samples, sampleRate, MODEL_RATE)
  const frames = Math.ceil(audio.length / MODEL_RATE / FRAME)
  let width = 0
  let segmentation = new Float32Array(0)
  let estimation = new Float32Array(0)
  const pieces = chunks(audio)
  for (let index = 0; index < pieces.length; index++) {
    const [from, to] = pieces[index]
    const piece = audio.slice(from, to)
    const encoded = await run('encoder', {
      waveform: { type: 'float32', data: piece, dims: [1, piece.length] },
      duration: { type: 'float32', data: new Float32Array([piece.length / MODEL_RATE]), dims: [1] },
    })
    if (!width) {
      width = encoded.x_seg.dims[2]
      segmentation = new Float32Array(frames * width)
      estimation = new Float32Array(frames * width)
    }
    const first = Math.round(from / MODEL_RATE / FRAME)
    const count = Math.min(encoded.x_seg.dims[1], frames - first)
    segmentation.set((encoded.x_seg.data as Float32Array).subarray(0, count * width), first * width)
    estimation.set((encoded.x_est.data as Float32Array).subarray(0, count * width), first * width)
    onProgress?.((index + 1) / pieces.length)
  }
  return { frames, width, segmentation, estimation }
}

async function transcribeChunk(audio: Float32Array, run: GameRuntime, language: bigint): Promise<GameNote[]> {
  const duration = audio.length / MODEL_RATE
  const encoded = await run('encoder', {
    waveform: { type: 'float32', data: audio, dims: [1, audio.length] },
    duration: { type: 'float32', data: new Float32Array([duration]), dims: [1] },
  })
  const known = (await run('dur2bd', {
    durations: { type: 'float32', data: new Float32Array([duration]), dims: [1, 1] },
    maskT: encoded.maskT,
  })).boundaries
  const refine = async (previous: GameTensor | GameOutput, step: number) => (await run('segmenter', {
    x_seg: encoded.x_seg,
    language: { type: 'int64', data: new BigInt64Array([language]), dims: [1] },
    known_boundaries: known,
    prev_boundaries: previous,
    t: { type: 'float32', data: new Float32Array([step / STEPS]), dims: [1] },
    maskT: encoded.maskT,
    threshold: scalar('float32', BOUNDARY_THRESHOLD),
    radius: scalar('int64', BOUNDARY_RADIUS),
  })).boundaries
  // Discrete diffusion: each pass refines the previous pass's boundaries.
  let boundaries: GameTensor | GameOutput = known
  for (let step = 0; step < STEPS; step++) boundaries = await refine(boundaries, step)
  const spans = await run('bd2dur', { boundaries, maskT: encoded.maskT })
  const estimate = await run('estimator', {
    x_est: encoded.x_est,
    boundaries,
    maskT: encoded.maskT,
    maskN: spans.maskN,
    threshold: scalar('float32', PRESENCE_THRESHOLD),
  })

  const features = encoded.x_seg.data as ArrayLike<number>
  const frames = encoded.x_seg.dims[1]
  const width = encoded.x_seg.dims[2]
  const durations = spans.durations.data as ArrayLike<number>
  const valid = spans.maskN.data as ArrayLike<number>
  const present = estimate.presence.data as ArrayLike<number>
  const pitches = estimate.scores.data as ArrayLike<number>
  const notes: GameNote[] = []
  let time = 0
  for (let index = 0; index < durations.length; index++) {
    if (!valid[index]) break
    const length = durations[index]
    if (present[index]) {
      const boundary = Math.round(time / FRAME)
      const context = new Float32Array(SPANS.length * width)
      SPANS.forEach(([before, after], span) => {
        const first = Math.max(0, boundary + before)
        const last = Math.min(frames, boundary + after)
        for (let frame = first; frame < last; frame++) {
          for (let channel = 0; channel < width; channel++) context[span * width + channel] += features[frame * width + channel]
        }
        if (last > first) for (let channel = 0; channel < width; channel++) context[span * width + channel] /= last - first
      })
      notes.push({ start: time, end: time + length, pitch: pitches[index], context })
    }
    time += length
  }
  return notes
}

/** Cut long audio at its quietest moments into pieces of at most `limit` seconds. */
function chunks(audio: Float32Array, limit = 20): Array<[number, number]> {
  const hop = Math.round(MODEL_RATE * 0.02)
  const envelope: number[] = []
  for (let index = 0; index + hop <= audio.length; index += hop) {
    let power = 0
    for (let offset = 0; offset < hop; offset++) power += audio[index + offset] ** 2
    envelope.push(power / hop)
  }
  const cuts = [0]
  let start = 0
  while ((audio.length - start) / MODEL_RATE > limit) {
    const from = Math.floor((start / MODEL_RATE + limit * 0.5) / 0.02)
    const to = Math.floor((start / MODEL_RATE + limit) / 0.02)
    let best = from
    let quietest = Infinity
    for (let frame = from; frame < to && frame < envelope.length - 10; frame++) {
      let level = 0
      for (let near = -5; near <= 5; near++) level += envelope[frame + near] ?? 0
      if (level < quietest) { quietest = level; best = frame }
    }
    start = best * hop
    cuts.push(start)
  }
  cuts.push(audio.length)
  return cuts.slice(0, -1).map((cut, index) => [cut, cuts[index + 1]])
}
