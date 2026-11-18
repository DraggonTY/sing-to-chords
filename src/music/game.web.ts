import type { GameModule, GameRuntime, GameTensor } from './game.ts'
import { onnx } from './onnx.web.ts'

const MODULES: GameModule[] = ['encoder', 'segmenter', 'estimator', 'dur2bd', 'bd2dur']
let loading: Promise<GameRuntime | null> | null = null

/**
 * Load the GAME model graphs from `models/game/` (fetched by `npm run models`).
 * Resolves to null when they are not installed, so the caller can fall back.
 */
export function loadGame(): Promise<GameRuntime | null> {
  loading ??= (async () => {
    const base = `${import.meta.env.BASE_URL}models/game/`
    try {
      // A dev server answers unknown paths with the app's HTML, so parse rather than trust the status.
      const config = await (await fetch(`${base}config.json`)).json() as { samplerate?: number; loop?: boolean }
      if (config.samplerate !== 44100 || !config.loop) return null
    } catch {
      return null
    }
    const ort = onnx()
    const sessions = new Map<GameModule, Awaited<ReturnType<typeof ort.InferenceSession.create>>>()
    for (const module of MODULES) {
      sessions.set(module, await ort.InferenceSession.create(`${base}${module}.onnx`, { executionProviders: ['wasm'] }))
    }
    return async (module, feeds) => {
      const inputs: Record<string, InstanceType<typeof ort.Tensor>> = {}
      for (const [name, value] of Object.entries(feeds)) {
        if (value instanceof ort.Tensor) inputs[name] = value
        else {
          const tensor = value as GameTensor
          // A subarray shares its buffer; the runtime needs its own copy.
          inputs[name] = new ort.Tensor(tensor.type, tensor.data.slice() as never, tensor.dims)
        }
      }
      return await sessions.get(module)!.run(inputs) as never
    }
  })()
  loading.then((runtime) => { if (!runtime) loading = null }, () => { loading = null })
  return loading
}
