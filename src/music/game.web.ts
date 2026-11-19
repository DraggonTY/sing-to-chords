import type { GameModule, GameRuntime, GameTensor } from './game.ts'
import { onnx } from './onnx.web.ts'

const MODULES: GameModule[] = ['encoder', 'segmenter', 'estimator', 'dur2bd', 'bd2dur']
export type GameSize = 'standard' | 'large'
export type LoadedGame = { run: GameRuntime; size: GameSize }
const FOLDERS: Record<GameSize, string> = { standard: 'game', large: 'game-large' }
const loading = new Map<GameSize, Promise<LoadedGame | null>>()

/** Whether this GAME model is installed under `models/` (`npm run models`, `npm run models:large`). */
export async function gameInstalled(size: GameSize): Promise<boolean> {
  try {
    // A dev server answers unknown paths with the app's HTML, so parse rather than trust the status.
    const config = await (await fetch(`${import.meta.env.BASE_URL}models/${FOLDERS[size]}/config.json`)).json() as { samplerate?: number; loop?: boolean }
    return config.samplerate === 44100 && config.loop === true
  } catch {
    return false
  }
}

/**
 * Load the GAME model graphs: the standard model from `models/game/`, or the larger one from
 * `models/game-large/` when it is asked for and installed. Resolves to null when no model is
 * installed, so the caller can fall back.
 */
export async function loadGame(prefer: GameSize = 'standard'): Promise<LoadedGame | null> {
  const size = prefer === 'large' && await gameInstalled('large') ? 'large' : 'standard'
  let pending = loading.get(size)
  if (!pending) {
    pending = loadSize(size)
    loading.set(size, pending)
    pending.then((game) => { if (!game) loading.delete(size) }, () => { loading.delete(size) })
  }
  return pending
}

async function loadSize(size: GameSize): Promise<LoadedGame | null> {
  if (!await gameInstalled(size)) return null
  const base = `${import.meta.env.BASE_URL}models/${FOLDERS[size]}/`
  const ort = onnx()
  const sessions = new Map<GameModule, Awaited<ReturnType<typeof ort.InferenceSession.create>>>()
  for (const module of MODULES) {
    sessions.set(module, await ort.InferenceSession.create(`${base}${module}.onnx`, { executionProviders: ['wasm'] }))
  }
  const run: GameRuntime = async (module, feeds) => {
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
  return { run, size }
}
