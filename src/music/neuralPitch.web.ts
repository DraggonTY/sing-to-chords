import type { PitchModel } from './neuralPitch.ts'
import { onnx } from './onnx.web.ts'

let loading: Promise<PitchModel> | null = null

/** Load the pitch model once. Everything runs on this device; nothing is uploaded. */
export function loadPitchModel(): Promise<PitchModel> {
  loading ??= (async () => {
    const ort = onnx()
    const session = await ort.InferenceSession.create(`${import.meta.env.BASE_URL}models/swift-f0.onnx`, { executionProviders: ['wasm'] })
    const low = new ort.Tensor('float32', [46.875], [])
    const high = new ort.Tensor('float32', [2093.75], [])
    return async (audio: Float32Array) => {
      // A subarray shares its buffer; the runtime needs its own copy.
      const input = new ort.Tensor('float32', audio.slice(), [1, audio.length])
      const output = await session.run({ audio: input, fmin: low, fmax: high })
      return { pitch: output.pitch.data as Float32Array, confidence: output.confidence.data as Float32Array }
    }
  })()
  loading.catch(() => { loading = null })
  return loading
}
