import { analysisFromNotes, analysisOnFoundBeat, type Analysis } from './analyze.ts'
import { extractSingingNotes, soundsNoisy } from './pitch.ts'
import type { RawNote } from './theory.ts'

self.onmessage = async (event: MessageEvent<{ samples: Float32Array; sampleRate: number; bpm: number | null }>) => {
  try {
    const { samples, sampleRate, bpm } = event.data
    // No tempo means no click was used: transcribe in seconds and find the beat from the singing.
    const tempo = bpm ?? 60
    let notes: RawNote[]
    let engine: Analysis['engine'] = 'built-in'
    let engineError: string | undefined
    // On real singers the two pitch trackers tie on clean recordings, and the
    // neural one keeps its accuracy in room noise where the built-in one loses
    // about three points. Load the model only for a recording that needs it.
    if (!soundsNoisy(samples, sampleRate)) notes = extractSingingNotes(samples, sampleRate, tempo)
    else try {
      engine = 'neural'
      const [{ extractSingingNotesNeural }, { loadPitchModel }] = await Promise.all([import('./neuralPitch.ts'), import('./neuralPitch.web.ts')])
      notes = await extractSingingNotesNeural(samples, sampleRate, tempo, await loadPitchModel())
    } catch (error) {
      // A recording the app refuses (too long, bad rate) is refused either way.
      if (error instanceof RangeError) throw error
      // The model could not load or run (offline first visit, old browser): use the built-in tracker.
      engine = 'built-in'
      engineError = error instanceof Error ? error.message : String(error)
      notes = extractSingingNotes(samples, sampleRate, tempo)
    }
    const analysis = bpm === null ? analysisOnFoundBeat(notes) : analysisFromNotes(notes)
    self.postMessage({ analysis: { ...analysis, engine, engineError } })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not transcribe this recording.' })
  }
}
