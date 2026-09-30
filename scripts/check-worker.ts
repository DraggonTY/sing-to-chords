import assert from 'node:assert/strict'
import { transcribeSinging } from '../src/music/transcribe.ts'

// Exercise the browser worker boundary without microphone access or downloads.
const expected = { key: { tonic: 0, mode: 'major' }, confidence: 0, notes: [] }
type Behavior = 'success' | 'pending' | 'send-error' | 'message-error' | 'load-error' | 'constructor-error'
class FakeWorker {
  static behavior: Behavior = 'success'
  static instances: FakeWorker[] = []
  terminated = false
  received: { samples: Float32Array } | null = null
  onmessage: ((event: unknown) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  constructor() {
    if (FakeWorker.behavior === 'constructor-error') throw new Error('worker blocked')
    FakeWorker.instances.push(this)
  }
  terminate() { this.terminated = true }
  postMessage(data: { samples: Float32Array }, transfer: ArrayBuffer[]) {
    if (FakeWorker.behavior === 'send-error') throw new Error('transfer failed')
    this.received = structuredClone(data, { transfer })
    queueMicrotask(() => {
      if (FakeWorker.behavior === 'success') this.onmessage?.({ data: { analysis: expected } })
      if (FakeWorker.behavior === 'message-error') this.onmessageerror?.()
      if (FakeWorker.behavior === 'load-error') this.onerror?.()
    })
  }
}
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
const samples = new Float32Array(16000)
try {
  assert.deepEqual(await transcribeSinging(samples, 16000, 120), expected)
  assert.ok(FakeWorker.instances.at(-1)!.terminated)
  assert.equal(samples.byteLength, 64000, 'caller audio is never detached')
  assert.equal(FakeWorker.instances.at(-1)!.received!.samples.length, samples.length)

  FakeWorker.behavior = 'pending'
  const controller = new AbortController()
  const pending = transcribeSinging(samples, 16000, 120, controller.signal)
  const worker = FakeWorker.instances.at(-1)!
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.ok(worker.terminated)
  // Events queued before cancellation must not trigger a fallback or resolve.
  worker.onerror?.()
  worker.onmessage?.({ data: { analysis: expected } })

  for (const behavior of ['send-error', 'message-error'] as const) {
    FakeWorker.behavior = behavior
    await assert.rejects(transcribeSinging(samples, 16000, 120))
    assert.ok(FakeWorker.instances.at(-1)!.terminated)
  }
  for (const behavior of ['load-error', 'constructor-error'] as const) {
    FakeWorker.behavior = behavior
    const result = await transcribeSinging(samples, 16000, 120)
    assert.deepEqual(result.notes, [])
    assert.equal(result.confidence, 0)
    assert.ok(FakeWorker.instances.at(-1)!.terminated)
  }
  console.log('ok worker client: copied transfer, cancellation, late events, failure cleanup, offline fallback')
} finally {
  if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker)
  else Reflect.deleteProperty(globalThis, 'Worker')
}
