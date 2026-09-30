import assert from 'node:assert/strict'
import Soundfont from 'soundfont-player'
import { Session } from '../src/audio/session.ts'

// Deterministic browser-audio boundary tests: no microphone, network or clocks.
class MockParam {
  value = 0
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class MockNode {
  disconnected = false
  connect(node: MockNode) { return node }
  disconnect() { this.disconnected = true }
}

class MockSource extends MockNode {
  frequency = new MockParam()
  starts: number[] = []
  stops: number[] = []
  onended: (() => void) | null = null
  addEventListener() {}
  start(time: number) { this.starts.push(time) }
  stop(time: number) { this.stops.push(time) }
}

class MockOscillator extends MockSource {}
class MockBufferSource extends MockSource { buffer: unknown }
class MockGain extends MockNode { gain = new MockParam() }
class MockFilter extends MockNode {
  frequency = new MockParam()
  Q = new MockParam()
}
class MockProcessor extends MockNode {
  onaudioprocess: ((event: unknown) => void) | null = null
}

class MockContext {
  state = 'running'
  currentTime = 10
  sampleRate = 48000
  destination = new MockNode()
  nodes: MockNode[] = []
  resume = async () => {}
  keep<T extends MockNode>(node: T): T { this.nodes.push(node); return node }
  createMediaStreamSource() { return this.keep(new MockNode()) }
  createScriptProcessor() { return this.keep(new MockProcessor()) }
  createGain() { return this.keep(new MockGain()) }
  createOscillator() { return this.keep(new MockOscillator()) }
  createBufferSource() { return this.keep(new MockBufferSource()) }
  createBiquadFilter() { return this.keep(new MockFilter()) }
  createBuffer(_channels: number, length: number) {
    const samples = new Float32Array(length)
    return { getChannelData: () => samples }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function microphone() {
  const track = { stopped: false, stop() { this.stopped = true } }
  return { track, getTracks: () => [track] }
}

function environment() {
  let nextTimer = 0
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const contexts: MockContext[] = []
  const requests: ReturnType<typeof deferred<ReturnType<typeof microphone>>>[] = []
  class AudioContext extends MockContext {
    constructor() { super(); contexts.push(this) }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    AudioContext,
    setTimeout(callback: () => void) { const id = ++nextTimer; timeouts.set(id, callback); return id },
    clearTimeout(id: number) { timeouts.delete(id) },
    setInterval(callback: () => void) { const id = ++nextTimer; intervals.set(id, callback); return id },
    clearInterval(id: number) { intervals.delete(id) },
  } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia() {
      const request = deferred<ReturnType<typeof microphone>>()
      requests.push(request)
      return request.promise
    } },
  } })
  Object.assign(globalThis, { OscillatorNode: MockOscillator, AudioBufferSourceNode: MockBufferSource })
  return { contexts, requests, timeouts, intervals }
}

function piano() {
  const played: { name: string; when: number; duration: number }[] = []
  const player = {
    play(name: string, when: number, options: { duration: number }) {
      played.push({ name, when, duration: options.duration })
    },
    stop() {},
  }
  return { player, played }
}

const note = { midi: 60, startBeat: 0, durationBeats: 0.25, velocity: 90 }
const originalInstrument = Soundfont.instrument

try {
  // Permission resolution after Stop must release the newly granted mic.
  {
    const env = environment()
    const session = new Session()
    const pending = session.arm(120, () => assert.fail('late beat notification'))
    assert.equal(session.finishTake(), null)
    const stream = microphone()
    env.requests[0].resolve(stream)
    await pending
    assert.equal(stream.track.stopped, true)
    assert.equal(env.contexts[0].nodes.length, 0)
    assert.equal(env.timeouts.size, 0)
  }

  // A stale request may not replace the active recording's stream or callback.
  {
    const env = environment()
    const session = new Session()
    const first = session.arm(120, () => assert.fail('stale arm callback'))
    const second = session.arm(120, () => {})
    const oldStream = microphone()
    const newStream = microphone()
    env.requests[1].resolve(newStream)
    await second
    env.requests[0].resolve(oldStream)
    await first
    assert.equal(oldStream.track.stopped, true)
    assert.equal(newStream.track.stopped, false)
    session.cancel()
    assert.equal(newStream.track.stopped, true)
    assert.equal(env.timeouts.size, 0)
  }

  // Cancelling also ignores a permission rejection that arrives afterward.
  {
    const env = environment()
    const session = new Session()
    const pending = session.arm(120, () => {})
    session.cancel()
    env.requests[0].reject(new Error('permission denied after cancellation'))
    await pending
    assert.equal(env.timeouts.size, 0)
  }

  // Stop cancels the look-ahead audio AND already queued UI beat notifications.
  {
    const env = environment()
    const session = new Session()
    const pending = session.arm(120, () => assert.fail('beat after stop'))
    const stream = microphone()
    env.requests[0].resolve(stream)
    await pending
    assert.ok(env.timeouts.size >= 2)
    const context = env.contexts[0]
    const click = context.nodes.find((node) => node instanceof MockOscillator) as MockOscillator
    assert.ok(click.starts[0] > context.currentTime)
    session.finishTake()
    assert.equal(env.timeouts.size, 0)
    assert.equal(click.stops.at(-1), context.currentTime)
    assert.equal(stream.track.stopped, true)
    assert.ok(context.nodes.filter((node) => !(node instanceof MockGain)).every((node) => node.disconnected))
  }

  // A crossing input buffer is trimmed at the count-in downbeat, once only.
  {
    const env = environment()
    const session = new Session()
    const pending = session.arm(120, () => {})
    env.requests[0].resolve(microphone())
    await pending
    const context = env.contexts[0]
    const processor = context.nodes.find((node) => node instanceof MockProcessor) as MockProcessor
    const samples = Float32Array.from({ length: 4096 }, (_, i) => i)
    // Count-in ends at 12.12; the first stored buffer spans 12.08–12.16533…
    context.currentTime = 12.08 + samples.length / context.sampleRate
    for (let i = 0; i < 4; i++) {
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
      context.currentTime += samples.length / context.sampleRate
    }
    const take = session.finishTake()
    assert.ok(take)
    assert.equal(take.sampleRate, 48000)
    assert.equal(take.samples[0], 1920)
    assert.equal(take.samples.length, 4096 * 4 - 1920)
    assert.equal(processor.onaudioprocess, null)
  }

  // Stop while samples load must prevent playback from starting later.
  {
    const env = environment()
    const loaded = deferred<ReturnType<typeof piano>['player']>()
    Soundfont.instrument = (() => loaded.promise) as typeof Soundfont.instrument
    const sound = piano()
    const heads: (number | null)[] = []
    const session = new Session()
    const pending = session.play([note], 120, true, (head) => heads.push(head))
    session.stopPlayback()
    loaded.resolve(sound.player)
    await pending
    assert.equal(sound.played.length, 0)
    assert.equal(env.intervals.size, 0)
    assert.equal(heads.at(-1), null)
  }

  // Replacement playback wins even when both calls share one loading promise.
  {
    const env = environment()
    const loaded = deferred<ReturnType<typeof piano>['player']>()
    Soundfont.instrument = (() => loaded.promise) as typeof Soundfont.instrument
    const sound = piano()
    const session = new Session()
    const first = session.play([note], 120, false, () => {})
    const second = session.play([{ ...note, midi: 67 }], 120, false, () => {})
    loaded.resolve(sound.player)
    await Promise.all([first, second])
    assert.deepEqual(sound.played.map((event) => event.name), ['G4'])
    assert.equal(env.intervals.size, 1)
    session.stopPlayback()
  }

  // Cancelling a pending context resume suppresses its later rejection, too.
  {
    const env = environment()
    const sound = piano()
    Soundfont.instrument = (async () => sound.player) as typeof Soundfont.instrument
    const session = new Session()
    await session.play([note], 120, false, () => {})
    session.stopPlayback()
    const context = env.contexts[0]
    const resumed = deferred<void>()
    context.state = 'suspended'
    context.resume = () => resumed.promise
    const pending = session.play([note], 120, false, () => {})
    session.stopPlayback()
    resumed.reject(new Error('resume failed after cancellation'))
    await pending
    assert.equal(sound.played.length, 1)
    assert.equal(env.intervals.size, 0)
  }

  // Short notes keep their duration; playhead follows audio time and clears.
  {
    const env = environment()
    const sound = piano()
    Soundfont.instrument = (async () => sound.player) as typeof Soundfont.instrument
    const heads: (number | null)[] = []
    const session = new Session()
    await session.play([note], 120, false, (head) => heads.push(head))
    assert.equal(sound.played[0].duration, 0.125)
    const context = env.contexts[0]
    context.currentTime = sound.played[0].when + 0.3
    for (const callback of env.intervals.values()) callback()
    assert.ok(Math.abs(heads.at(-1)! - 0.6) < 1e-10)
    // Repeated timer ticks while audio is suspended must not advance the head.
    for (const callback of env.intervals.values()) callback()
    assert.ok(Math.abs(heads.at(-1)! - 0.6) < 1e-10)
    session.stopPlayback()
    assert.equal(heads.at(-1), null)
    assert.equal(env.intervals.size, 0)
  }

  // The offline piano also respects short notes and cancels buffer sources.
  {
    const env = environment()
    Soundfont.instrument = async () => { throw new Error('offline') }
    const session = new Session()
    await session.play([{ ...note, durationBeats: 0.05 }], 120, false, () => {})
    const context = env.contexts[0]
    const sources = context.nodes.filter((node) => node instanceof MockSource) as MockSource[]
    assert.ok(sources.some((source) => source instanceof MockBufferSource))
    assert.ok(sources.every((source) => source.stops[0] <= source.starts[0] + 0.025 + 1e-10))
    session.stopPlayback()
    assert.ok(sources.every((source) => source.stops.at(-1) === context.currentTime))
    assert.ok(context.nodes.every((node) => node.disconnected))
  }

  console.log('ok session: recording cancellation, count-in trim, playback cancellation, audio clock, short notes')
} finally {
  Soundfont.instrument = originalInstrument
}
