import { analysisFromNotes } from './analyze.ts'
import { extractSingingNotes } from './pitch.ts'

self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number; bpm: number }>) => {
  try {
    const { samples, sampleRate, bpm } = event.data
    const analysis = analysisFromNotes(extractSingingNotes(samples, sampleRate, bpm))
    self.postMessage({ analysis })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not transcribe this recording.' })
  }
}
