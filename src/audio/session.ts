import Soundfont, { type Player } from 'soundfont-player'
import { noteName } from '../music/theory.ts'

export type RecordedTake = {
  samples: Float32Array
  sampleRate: number
}

export type PlayableNote = {
  midi: number
  startBeat: number
  durationBeats: number
  velocity: number
}

type BeatHandler = (beatInBar: number, phase: 'count' | 'record') => void

export class Session {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private inputNodes: AudioNode[] = []
  private inputVersion = 0
  private playbackVersion = 0
  private metronomeTimer = 0
  private beatTimers = new Set<number>()
  private clickNodes = new Set<OscillatorNode>()
  private nextBeatTime = 0
  private beatIndex = 0
  private bpm = 90
  private recording = false
  private chunks: Float32Array[] = []
  private captureStartedAt = 0
  private downbeatAt = 0
  private onBeat: BeatHandler = () => {}
  private playback: { nodes: AudioNode[]; timer: number } | null = null
  private playbackHead: ((beat: number | null) => void) | null = null
  private piano: Player | null = null
  private pianoLoading: Promise<Player> | null = null

  async arm(bpm: number, onBeat: BeatHandler): Promise<void> {
    this.stopPlayback()
    this.stopClicks()
    this.releaseInput()
    const version = this.inputVersion
    this.bpm = bpm
    this.onBeat = onBeat
    this.chunks = []
    this.recording = false
    this.beatIndex = 0

    const context = this.getContext()
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch (error) {
        if (version !== this.inputVersion) return
        throw error
      }
    }
    if (version !== this.inputVersion) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
    } catch (error) {
      if (version !== this.inputVersion) return
      throw error
    }
    if (version !== this.inputVersion) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.stream = stream

    const source = context.createMediaStreamSource(this.stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0
    processor.onaudioprocess = (event) => {
      if (version !== this.inputVersion) return
      const channel = event.inputBuffer.getChannelData(0)
      if (this.chunks.length === 0) {
        // ScriptProcessor does not expose the input block's timestamp. Its
        // playbackTime describes the OUTPUT buffer, so it cannot be used as
        // an exact capture timestamp. This estimate excludes device latency.
        this.captureStartedAt = context.currentTime - channel.length / context.sampleRate
      }
      if (!this.recording && context.currentTime < this.downbeatAt) return
      this.recording = true
      this.chunks.push(new Float32Array(channel))
    }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)
    this.processor = processor
    this.inputNodes = [source, processor, mute]

    const lead = 0.12
    this.nextBeatTime = context.currentTime + lead
    this.downbeatAt = this.nextBeatTime + (60 / bpm) * 4
    this.scheduleClicks()
  }

  finishTake(): RecordedTake | null {
    this.stopClicks()
    const context = this.context
    const chunks = this.chunks
    const sampleRate = context?.sampleRate ?? 44100
    const captureStartedAt = this.captureStartedAt
    const downbeatAt = this.downbeatAt
    this.releaseInput()
    if (!context || chunks.length === 0) return null

    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const mixed = new Float32Array(length)
    let offset = 0
    for (const chunk of chunks) {
      mixed.set(chunk, offset)
      offset += chunk.length
    }

    const skip = Math.max(0, Math.round((downbeatAt - captureStartedAt) * sampleRate))
    if (skip >= mixed.length - sampleRate * 0.25) return null
    return { samples: mixed.subarray(skip), sampleRate }
  }

  cancel(): void {
    this.stopClicks()
    this.stopPlayback()
    this.releaseInput()
  }

  async play(
    notes: PlayableNote[],
    bpm: number,
    withClick: boolean,
    onHead: (beat: number | null) => void,
  ): Promise<void> {
    this.stopPlayback()
    const version = this.playbackVersion
    this.playbackHead = onHead
    const context = this.getContext()
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch (error) {
        if (version !== this.playbackVersion) return
        this.stopPlayback()
        throw error
      }
    }
    if (version !== this.playbackVersion) return
    const piano = await this.loadPiano(context)
    if (version !== this.playbackVersion) return
    const start = context.currentTime + 0.12
    const beat = 60 / bpm
    const nodes: AudioNode[] = []
    const playback = { nodes, timer: 0 }
    this.playback = playback
    let endBeat = 1
    try {
      for (const note of notes) {
        endBeat = Math.max(endBeat, note.startBeat + note.durationBeats)
        const when = start + note.startBeat * beat
        const duration = Math.max(1 / context.sampleRate, note.durationBeats * beat)
        if (piano) {
          piano.play(noteName(note.midi), when, { duration, gain: Math.min(1, note.velocity / 100) })
        } else {
          nodes.push(...strikePiano(context, midiToFreq(note.midi), when, duration, note.velocity / 127))
        }
      }

      if (withClick) {
        const clicks = Math.ceil(endBeat)
        for (let index = 0; index < clicks; index++) {
          nodes.push(strikeClick(context, start + index * beat, index % 4 === 0))
        }
      }
    } catch (error) {
      this.stopPlayback()
      throw error
    }

    const timer = window.setInterval(() => {
      if (version !== this.playbackVersion) return
      const position = (context.currentTime - start) / beat
      if (position > endBeat + 0.2) {
        this.stopPlayback()
        return
      }
      onHead(Math.max(0, position))
    }, 40)
    playback.timer = timer
  }

  stopPlayback(): void {
    this.playbackVersion += 1
    this.playbackHead?.(null)
    this.playbackHead = null
    this.piano?.stop()
    if (!this.playback) return
    window.clearInterval(this.playback.timer)
    const when = this.context ? this.context.currentTime : 0
    for (const node of this.playback.nodes) {
      if (node instanceof OscillatorNode || node instanceof AudioBufferSourceNode) {
        try {
          node.stop(when)
        } catch {
          /* already stopped */
        }
      }
      node.disconnect()
    }
    this.playback = null
  }

  private scheduleClicks(): void {
    const context = this.context
    if (!context) return
    const version = this.inputVersion
    const beat = 60 / this.bpm
    while (this.nextBeatTime < context.currentTime + 0.18) {
      const node = strikeClick(context, this.nextBeatTime, this.beatIndex % 4 === 0)
      this.clickNodes.add(node)
      node.addEventListener('ended', () => this.clickNodes.delete(node), { once: true })
      const phase = this.beatIndex < 4 ? 'count' : 'record'
      const beatInBar = this.beatIndex % 4
      const delay = Math.max(0, (this.nextBeatTime - context.currentTime) * 1000)
      const timer = window.setTimeout(() => {
        this.beatTimers.delete(timer)
        if (version === this.inputVersion) this.onBeat(beatInBar, phase)
      }, delay)
      this.beatTimers.add(timer)
      this.beatIndex += 1
      this.nextBeatTime += beat
    }
    this.metronomeTimer = window.setTimeout(() => this.scheduleClicks(), 25)
  }

  private stopClicks(): void {
    window.clearTimeout(this.metronomeTimer)
    this.metronomeTimer = 0
    for (const timer of this.beatTimers) window.clearTimeout(timer)
    this.beatTimers.clear()
    for (const node of this.clickNodes) {
      try {
        node.stop(this.context?.currentTime ?? 0)
      } catch {
        /* already stopped */
      }
      node.disconnect()
    }
    this.clickNodes.clear()
  }

  private loadPiano(context: AudioContext): Promise<Player | null> {
    if (this.piano) return Promise.resolve(this.piano)
    if (!this.pianoLoading) {
      this.pianoLoading = Soundfont.instrument(context, 'acoustic_grand_piano', { gain: 0.9 })
        .then((player) => {
          this.piano = player
          return player
        })
        .catch((error: unknown) => {
          this.pianoLoading = null
          throw error
        })
    }
    return this.pianoLoading.catch(() => null)
  }

  private getContext(): AudioContext {
    if (!this.context) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.context = new Ctx()
    }
    return this.context
  }

  private releaseInput(): void {
    this.inputVersion += 1
    this.recording = false
    if (this.processor) this.processor.onaudioprocess = null
    for (const node of this.inputNodes) node.disconnect()
    this.inputNodes = []
    this.processor = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.chunks = []
  }
}

function strikePiano(
  context: AudioContext,
  freq: number,
  time: number,
  duration: number,
  velocity: number,
): AudioNode[] {
  const partials = [1, 2, 3, 4, 5, 6, 8]
  const gains = [1, 0.38, 0.2, 0.12, 0.07, 0.04, 0.02]
  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(2200 + velocity * 1800, time)
  filter.frequency.exponentialRampToValueAtTime(900, time + duration)
  filter.Q.value = 0.6
  const master = context.createGain()
  master.gain.value = 0.22
  filter.connect(master)
  master.connect(context.destination)
  const nodes: AudioNode[] = [filter, master]

  partials.forEach((partial, index) => {
    const osc = context.createOscillator()
    osc.type = 'sine'
    const stretch = 1 + partial * partial * 0.00015
    osc.frequency.value = freq * partial * stretch
    const gain = context.createGain()
    const peak = Math.max(0.0001, velocity * gains[index])
    const decay = Math.max(0.001, duration * (1 - index * 0.09))
    const attack = Math.min(0.012, decay * 0.3)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(peak, time + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    osc.connect(gain)
    gain.connect(filter)
    osc.start(time)
    osc.stop(time + decay)
    nodes.push(osc, gain)
  })

  const noiseLength = Math.floor(context.sampleRate * 0.03)
  const noiseBuffer = context.createBuffer(1, noiseLength, context.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let index = 0; index < noiseLength; index++) data[index] = (Math.random() * 2 - 1) * (1 - index / noiseLength)
  const noise = context.createBufferSource()
  noise.buffer = noiseBuffer
  const noiseGain = context.createGain()
  noiseGain.gain.setValueAtTime(velocity * 0.18, time)
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(0.04, duration))
  const clickFilter = context.createBiquadFilter()
  clickFilter.type = 'highpass'
  clickFilter.frequency.value = 900
  noise.connect(clickFilter)
  clickFilter.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(time)
  noise.stop(time + Math.min(0.05, duration))
  nodes.push(noise, noiseGain, clickFilter)
  return nodes
}

function strikeClick(context: AudioContext, time: number, accent: boolean): OscillatorNode {
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = 'square'
  osc.frequency.value = accent ? 1760 : 1320
  gain.gain.setValueAtTime(accent ? 0.16 : 0.08, time)
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04)
  osc.connect(gain)
  gain.connect(context.destination)
  osc.onended = () => {
    osc.disconnect()
    gain.disconnect()
  }
  osc.start(time)
  osc.stop(time + 0.05)
  return osc
}

function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}
