import { analysisFromNotes, analysisOnFoundBeat, type Analysis } from './analyze.ts'
import { extractSingingNotes, soundsNoisy } from './pitch.ts'
import type { RawNote } from './theory.ts'

type Request = { samples: Float32Array; sampleRate: number; bpm: number | null; largeModel?: boolean }

/** Notes in seconds (that is, at 60 BPM) from the best engine available, and which one it was. */
async function transcribe(samples: Float32Array, sampleRate: number, largeModel: boolean): Promise<{ notes: RawNote[]; engine: Analysis['engine']; engineError?: string }> {
  let engineError: string | undefined
  // 1. GAME, a model trained to turn singing into notes. Installed by `npm run models` and
  // `npm run models:large`. If the larger model cannot run here, the standard one is tried.
  const tried = new Set<string>()
  for (const size of largeModel ? ['large', 'standard'] as const : ['standard'] as const) {
    try {
      const [{ gameNotes }, { loadGame }, { tidyGameNotes, tidyModelFor }] = await Promise.all([import('./game.ts'), import('./game.web.ts'), import('./gameTidy.ts')])
      const game = await loadGame(size)
      if (!game || tried.has(game.size)) continue
      tried.add(game.size)
      const heard = await gameNotes(samples, sampleRate, game.run, (done) => self.postMessage({ progress: done }))
      return { notes: tidyGameNotes(heard, await tidyModelFor(heard)), engine: game.size === 'large' ? 'game-large' : 'game', engineError }
    } catch (error) {
      // A recording the app refuses (too long, bad rate) is refused by every engine.
      if (error instanceof RangeError) throw error
      engineError = error instanceof Error ? error.message : String(error)
    }
  }
  // 2. Pitch tracking plus the built-in note segmenter. The two pitch trackers tie on clean
  // recordings; the neural one keeps its accuracy in room noise, so it is loaded only then.
  if (soundsNoisy(samples, sampleRate)) {
    try {
      const [{ extractSingingNotesNeural }, { loadPitchModel }] = await Promise.all([import('./neuralPitch.ts'), import('./neuralPitch.web.ts')])
      return { notes: await extractSingingNotesNeural(samples, sampleRate, 60, await loadPitchModel()), engine: 'neural', engineError }
    } catch (error) {
      if (error instanceof RangeError) throw error
      engineError = error instanceof Error ? error.message : String(error)
    }
  }
  return { notes: extractSingingNotes(samples, sampleRate, 60), engine: 'built-in', engineError }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const { samples, sampleRate, bpm, largeModel } = event.data
    if (bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) throw new RangeError('Tempo must be a positive number.')
    const { notes, engine, engineError } = await transcribe(samples, sampleRate, largeModel === true)
    // No tempo means no click was used: find the beat from the singing. Otherwise seconds become beats.
    const analysis = bpm === null
      ? analysisOnFoundBeat(notes)
      : analysisFromNotes(notes.map((note) => ({ ...note, startBeat: note.startBeat * bpm / 60, durationBeats: note.durationBeats * bpm / 60 })))
    self.postMessage({ analysis: { ...analysis, engine, engineError } })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not transcribe this recording.' })
  }
}
