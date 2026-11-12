import { analysisFromNotes, analyzeFreely } from './analyze.ts'
import { extractSingingNotes } from './pitch.ts'

self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number; bpm: number | null }>) => {
  try {
    const { samples, sampleRate, bpm } = event.data
    // No tempo means no click was used: find the beat from the singing.
    const analysis = bpm === null ? analyzeFreely(samples, sampleRate) : analysisFromNotes(extractSingingNotes(samples, sampleRate, bpm))
    self.postMessage({ analysis })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not transcribe this recording.' })
  }
}
