import * as ort from 'onnxruntime-web/wasm'
import type { PitchModel } from './neuralPitch.ts'
// The runtime's WebAssembly binary and its loader, served from this app (no CDN). A relative
// path is used because the package does not export the file by name.
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import glueUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'

let loading: Promise<PitchModel> | null = null

/** Load the pitch model once. Everything runs on this device; nothing is uploaded. */
export function loadPitchModel(): Promise<PitchModel> {
  loading ??= (async () => {
    // One thread: more needs cross-origin isolation, and the model is tiny.
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: glueUrl }
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
