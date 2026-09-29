import { instrument, type Player } from 'soundfont-player'
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
  private metronomeTimer = 0
  private nextBeatTime = 0
  private beatIndex = 0
  private bpm = 90
  private recording = false
  private chunks: Float32Array[] = []
  private captureStartedAt = 0
  private downbeatAt = 0
  private onBeat: BeatHandler = () => {}
  private playback: { nodes: AudioNode[]; timer: number } | null = null
  private piano: Player | null = null
  private pianoLoading: Promise<Player> | null = null

  async arm(bpm: number, onBeat: BeatHandler): Promise<void> {
    this.stopPlayback()
    await this.releaseInput()
    this.bpm = bpm
    this.onBeat = onBeat
    this.chunks = []
    this.recording = false
    this.beatIndex = 0

    const context = this.getContext()
    if (context.state === 'suspended') await context.resume()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    const source = context.createMediaStreamSource(this.stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0
    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0)
      if (this.chunks.length === 0) {
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
    void this.releaseInput()
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
    void this.releaseInput()
  }

  async play(
    notes: PlayableNote[],
    bpm: number,
    withClick: boolean,
    onHead: (beat: number | null) => void,
  ): Promise<void> {
    this.stopPlayback()
    const context = this.getContext()
    if (context.state === 'suspended') await context.resume()
    const piano = await this.loadPiano(context)
    const start = context.currentTime + 0.12
    const beat = 60 / bpm
    const nodes: AudioNode[] = []
    let endBeat = 1
    for (const note of notes) {
      endBeat = Math.max(endBeat, note.startBeat + note.durationBeats)
      const when = start + note.startBeat * beat
      const duration = Math.max(0.18, note.durationBeats * beat)
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

    const started = performance.now()
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - started) / 1000 - 0.08
      const position = elapsed / beat
      if (position > endBeat + 0.2) {
        onHead(null)
        window.clearInterval(timer)
        if (this.playback) this.playback.timer = 0
        return
      }
      onHead(Math.max(0, position))
    }, 40)
    this.playback = { nodes, timer }
  }

  stopPlayback(): void {
    this.piano?.stop()
    if (!this.playback) return
    window.clearInterval(this.playback.timer)
    const when = this.context ? this.context.currentTime : 0
    for (const node of this.playback.nodes) {
      if (node instanceof OscillatorNode) {
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
    const beat = 60 / this.bpm
    while (this.nextBeatTime < context.currentTime + 0.18) {
      strikeClick(context, this.nextBeatTime, this.beatIndex % 4 === 0)
      const phase = this.beatIndex < 4 ? 'count' : 'record'
      const beatInBar = this.beatIndex % 4
      const delay = Math.max(0, (this.nextBeatTime - context.currentTime) * 1000)
      window.setTimeout(() => this.onBeat(beatInBar, phase), delay)
      this.beatIndex += 1
      this.nextBeatTime += beat
    }
    this.metronomeTimer = window.setTimeout(() => this.scheduleClicks(), 25)
  }

  private stopClicks(): void {
    window.clearTimeout(this.metronomeTimer)
    this.metronomeTimer = 0
  }

  private loadPiano(context: AudioContext): Promise<Player | null> {
    if (this.piano) return Promise.resolve(this.piano)
    if (!this.pianoLoading) {
      this.pianoLoading = instrument(context, 'acoustic_grand_piano', { gain: 0.9 })
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

  private async releaseInput(): Promise<void> {
    this.recording = false
    this.processor?.disconnect()
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
    const decay = Math.max(0.28, duration * (1.15 - index * 0.12))
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    osc.connect(gain)
    gain.connect(filter)
    osc.start(time)
    osc.stop(time + decay + 0.02)
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
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04)
  const clickFilter = context.createBiquadFilter()
  clickFilter.type = 'highpass'
  clickFilter.frequency.value = 900
  noise.connect(clickFilter)
  clickFilter.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(time)
  noise.stop(time + 0.05)
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
  osc.start(time)
  osc.stop(time + 0.05)
  return osc
}

function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}
