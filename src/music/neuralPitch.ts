import { checkRecording, frameEnergies, notesFromPitch, prepareAudio } from './pitch.ts'
import type { MelodyFrame } from './segment.ts'
import type { RawNote } from './theory.ts'

/**
 * SwiftF0 (Nieradzik, 2025; MIT): a small convolutional pitch tracker. It takes
 * mono audio at 16 kHz and returns a pitch and a voicing confidence for every
 * 256-sample hop (16 ms). On real singers it matches the built-in tracker on
 * clean recordings and holds its accuracy in room noise, where the built-in
 * tracker loses several points.
 */
export type PitchModel = (audio16k: Float32Array) => Promise<{ pitch: ArrayLike<number>; confidence: ArrayLike<number> }>

const MODEL_RATE = 16000
const HOP = 256
// The model sees 30 s at a time, with context on both sides of each window.
const WINDOW_FRAMES = 1875
const LEFT_FRAMES = 11
const LOOKAHEAD_FRAMES = 10
const VOICED = 0.5
const SILENCE_PEAK = 1e-3

/** Extract one sung melody with the neural pitch tracker and the shared note segmenter. */
export async function extractSingingNotesNeural(
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
  model: PitchModel,
): Promise<RawNote[]> {
  if (!checkRecording(samples, sampleRate, bpm)) return []
  const seconds = samples.length / sampleRate
  const audio = prepareAudio(samples, sampleRate, MODEL_RATE)
  const count = Math.max(1, Math.floor(audio.length / HOP))
  const pitch = new Float64Array(count)
  const voiced = new Uint8Array(count)
  for (let start = 0; start < count; start += WINDOW_FRAMES) {
    const end = Math.min(start + WINDOW_FRAMES, count)
    const left = Math.max(0, start - LEFT_FRAMES)
    const window = end < count ? audio.subarray(left * HOP, (end + LOOKAHEAD_FRAMES) * HOP) : audio.subarray(left * HOP)
    const result = await model(window)
    for (let frame = start; frame < end; frame++) {
      const hz = result.pitch[frame - left]
      let peak = 0
      for (let index = frame * HOP; index < (frame + 1) * HOP && index < audio.length; index++) peak = Math.max(peak, Math.abs(audio[index]))
      if (result.confidence[frame - left] >= VOICED && peak >= SILENCE_PEAK && hz > 0 && Number.isFinite(hz)) {
        pitch[frame] = 69 + 12 * Math.log2(hz / 440)
        voiced[frame] = 1
      }
    }
  }

  // The segmenter works in 10 ms frames; the model in 16 ms hops.
  const energies = frameEnergies(prepareAudio(samples, sampleRate))
  const contour: MelodyFrame[] = energies.map((energy, index) => {
    const time = index * 0.01
    const position = time * MODEL_RATE / HOP
    const low = Math.floor(position)
    const mix = position - low
    const before = low < count && voiced[low] ? pitch[low] : null
    const after = low + 1 < count && voiced[low + 1] ? pitch[low + 1] : null
    let value: number | null
    // Interpolate inside a voiced stretch; never across a leap or into silence.
    if (before !== null && after !== null) value = Math.abs(before - after) < 2 ? before + (after - before) * mix : mix < 0.5 ? before : after
    else value = mix < 0.5 ? before : after
    return { time, pitch: value, energy }
  })
  return notesFromPitch(contour, seconds, bpm)
}
