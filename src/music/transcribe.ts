import { analysisFromNotes, type Analysis } from './analyze.ts'
import { extractSingingNotes } from './pitch.ts'

export async function transcribeSinging(
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
  signal?: AbortSignal,
): Promise<Analysis> {
  if (signal?.aborted) throw new DOMException('Transcription cancelled.', 'AbortError')
  const runLocally = () => analysisFromNotes(extractSingingNotes(samples, sampleRate, bpm))
  if (typeof Worker === 'undefined') return runLocally()
  let worker: Worker
  try {
    worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return runLocally()
  }
  return new Promise<Analysis>((resolve, reject) => {
    let finished = false
    const finish = () => {
      if (finished) return false
      finished = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      return true
    }
    const abort = () => {
      if (finish()) reject(new DOMException('Transcription cancelled.', 'AbortError'))
    }
    const timeout = setTimeout(() => {
      if (finish()) reject(new Error('Transcription took too long. Please try a shorter recording.'))
    }, 120000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ analysis?: Analysis; error?: string }>) => {
      if (!finish()) return
      if (event.data.analysis) resolve(event.data.analysis)
      else reject(new Error(event.data.error ?? 'Could not transcribe this recording.'))
    }
    worker.onerror = () => {
      if (!finish()) return
      // Module workers are restricted by some browsers; preserve offline use.
      try { resolve(runLocally()) }
      catch (error) { reject(error) }
    }
    worker.onmessageerror = () => {
      if (finish()) reject(new Error('Could not read the transcription result.'))
    }
    try {
      // Playback owns the original buffer, so only transfer a copy to the worker.
      const copy = samples.slice()
      worker.postMessage({ samples: copy, sampleRate, bpm }, [copy.buffer])
    } catch (error) {
      if (finish()) reject(error)
    }
  })
}
