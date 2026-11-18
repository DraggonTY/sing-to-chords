import * as ort from 'onnxruntime-web/wasm'
// The runtime's WebAssembly binary and its loader, served from this app (no CDN). Relative
// paths are used because the package does not export the files by name.
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import glueUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'

let configured = false

/** The ONNX runtime, configured once. Everything runs on this device; nothing is uploaded. */
export function onnx(): typeof ort {
  if (!configured) {
    configured = true
    ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: glueUrl }
    // Threads need a cross-origin-isolated page (see vite.config.ts); without it, one thread.
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
    ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(6, (navigator.hardwareConcurrency ?? 2) - 1)) : 1
  }
  return ort
}
