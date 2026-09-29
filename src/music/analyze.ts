import {
  detectKey,
  keyFromMelody,
  pitchClass,
  rankChordsForGroup,
  type Chord,
  type KeySignature,
  type RawNote,
} from './theory.ts'

export type QuantizeDivision = 'off' | '8' | '16'
export type ChordSpan = 1 | 2 | 4

export type ChordSlot = {
  id: string
  startBeat: number
  durationBeats: number
  chord: Chord
  options: Chord[]
  edited: boolean
}

export type Analysis = {
  key: KeySignature
  confidence: number
  notes: RawNote[]
}

const ANALYSIS_RATE = 16000
const WINDOW = 1024
const HOP = 192

export function analyzeRecording(samples: Float32Array, sampleRate: number, bpm: number): Analysis {
  const audio = downsample(samples, sampleRate, ANALYSIS_RATE)
  const frames = trackPitch(audio, ANALYSIS_RATE)
  const segments = segmentNotes(frames, HOP / ANALYSIS_RATE)
  const fit = keyFromMelody(segments.map((segment) => ({ pitch: segment.pitch, weight: segment.duration })))
  const notes = segments.map((segment, index) => {
    const startBeat = round3((segment.start * bpm) / 60)
    const durationBeats = Math.max(0.2, round3((segment.duration * bpm) / 60))
    const midi = Math.round(segment.pitch)
    return {
      id: `n${index}-${midi}-${Math.round(startBeat * 100)}`,
      midi,
      startBeat,
      durationBeats,
    }
  })
  const analysis = finishAnalysis(notes)
  return { ...analysis, key: fit.key, confidence: Math.max(analysis.confidence, fit.confidence) }
}

export function analyzeNoteList(notes: RawNote[]): Analysis {
  return finishAnalysis(notes)
}

export function layoutChords(
  notes: RawNote[],
  key: KeySignature,
  edits: Record<string, string>,
  span: ChordSpan,
): ChordSlot[] {
  const end = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  const slots: ChordSlot[] = []
  let previous: Chord | null = null
  for (let start = 0; start < end; start += span) {
    const inside = notes.filter((note) => note.startBeat >= start && note.startBeat < start + span)
    if (!inside.length) continue
    const options = rankChordsForGroup(inside, key, previous)
    const id = `${span}@${start}`
    const chosen = options.find((chord) => chord.id === edits[id]) ?? options[0]
    previous = chosen
    slots.push({
      id,
      startBeat: start,
      durationBeats: span,
      chord: chosen,
      options,
      edited: Boolean(edits[id] && options.some((chord) => chord.id === edits[id])),
    })
  }
  return slots
}

export function applyQuantize(notes: RawNote[], division: QuantizeDivision): RawNote[] {
  if (division === 'off') {
    return notes.map((note) => ({
      id: note.id,
      midi: note.midi,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
    }))
  }
  const grid = division === '8' ? 0.5 : 0.25
  const quantized = notes
    .map((note) => {
      const start = Math.round(note.startBeat / grid) * grid
      let end = Math.round((note.startBeat + note.durationBeats) / grid) * grid
      if (end - start < grid) end = start + grid
      return {
        ...note,
        startBeat: round3(start),
        durationBeats: round3(end - start),
      }
    })
    .sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)

  for (let index = 0; index < quantized.length - 1; index++) {
    const nextStart = quantized[index + 1].startBeat
    const end = quantized[index].startBeat + quantized[index].durationBeats
    if (end > nextStart) {
      quantized[index] = {
        ...quantized[index],
        durationBeats: round3(Math.max(grid, nextStart - quantized[index].startBeat)),
      }
    }
  }
  return quantized
}

export function placeLabel(startBeat: number): string {
  const bar = Math.floor(startBeat / 4) + 1
  const within = ((startBeat % 4) + 4) % 4
  const quarter = Math.floor(within + 1e-6)
  const fraction = within - quarter
  const nearest = Math.round(fraction * 4) / 4
  if (Math.abs(fraction - nearest) < 0.03) {
    const suffix = ['', 'e', '&', 'a'][Math.round(fraction * 4) % 4]
    return `${bar}.${quarter + 1}${suffix}`
  }
  return `${bar} · ${(within + 1).toFixed(2)}`
}

function finishAnalysis(notes: RawNote[]): Analysis {
  const histogram = new Array<number>(12).fill(0)
  for (const note of notes) histogram[pitchClass(note.midi)] += note.durationBeats
  const detected = notes.length ? detectKey(histogram) : { key: { tonic: 0, mode: 'major' as const }, confidence: 0 }
  return { key: detected.key, confidence: detected.confidence, notes }
}

export function analysisFromNotes(notes: RawNote[]): Analysis {
  const fit = keyFromMelody(notes.map((note) => ({ pitch: note.midi, weight: note.durationBeats })))
  const analysis = finishAnalysis(notes)
  return { ...analysis, key: fit.key, confidence: Math.max(analysis.confidence, fit.confidence) }
}

type Frame = { time: number; midi: number | null }

type PitchFrame = { time: number; pitch: number | null; energy: number }

function trackPitch(samples: Float32Array, sampleRate: number): Frame[] {
  const cleaned = highpass(samples, sampleRate, 60)
  const measured: PitchFrame[] = []

  for (let offset = 0; offset + WINDOW < cleaned.length; offset += HOP) {
    const frame = cleaned.subarray(offset, offset + WINDOW)
    const energy = rms(frame)
    const pitch = mpm(frame, sampleRate)
    const midi = pitch && pitch.clarity >= 0.58 ? continuousMidi(pitch.freq) : null
    measured.push({ time: offset / sampleRate, pitch: midi, energy })
  }

  const energies = measured.map((frame) => frame.energy).sort((a, b) => a - b)
  const loud = energies[Math.floor(energies.length * 0.85)] ?? 0
  const floor = Math.max(0.008, loud * 0.055)
  for (const frame of measured) {
    if (frame.energy < floor || frame.pitch == null || frame.pitch < 36 || frame.pitch > 84) frame.pitch = null
  }

  const smoothed = measured.map((frame, index) => {
    const nearby: number[] = []
    for (let cursor = Math.max(0, index - 1); cursor <= Math.min(measured.length - 1, index + 1); cursor++) {
      const pitch = measured[cursor].pitch
      if (pitch != null && (frame.pitch == null || Math.abs(pitch - frame.pitch) < 1.4)) nearby.push(pitch)
    }
    if (nearby.length < 2) return frame
    return { ...frame, pitch: median(nearby) }
  })

  for (let index = 0; index < smoothed.length; index++) {
    const pitch = smoothed[index].pitch
    if (pitch == null) continue
    const neighbors: number[] = []
    for (let cursor = Math.max(0, index - 4); cursor <= Math.min(smoothed.length - 1, index + 4); cursor++) {
      if (cursor === index) continue
      const other = smoothed[cursor].pitch
      if (other != null) neighbors.push(other)
    }
    if (neighbors.length < 4) continue
    const center = median(neighbors)
    if (Math.abs(pitch - 12 - center) < 1.2) smoothed[index].pitch = pitch - 12
    else if (Math.abs(pitch + 12 - center) < 1.2) smoothed[index].pitch = pitch + 12
  }

  return smoothed.map((frame) => ({
    time: frame.time,
    midi: frame.pitch == null ? null : Math.round(frame.pitch),
    pitch: frame.pitch,
  }))
}

function segmentNotes(frames: Array<Frame & { pitch?: number | null }>, hopSeconds: number): { pitch: number; start: number; duration: number }[] {
  const notes: { pitch: number; start: number; end: number }[] = []
  let current: { pitches: number[]; start: number; end: number } | null = null
  let pending: number[] = []

  const close = () => {
    if (!current || current.pitches.length < 2) {
      current = null
      return
    }
    const duration = current.end - current.start
    if (duration >= 0.09) notes.push({ pitch: dwellPitch(current.pitches), start: current.start, end: current.end })
    current = null
  }

  for (const frame of frames) {
    const pitch = frame.pitch
    if (pitch == null) {
      pending = []
      if (current && frame.time - current.end > 0.035) close()
      continue
    }
    if (!current) {
      current = { pitches: [pitch], start: frame.time, end: frame.time + hopSeconds }
      continue
    }
    const locked = median(current.pitches)
    const sameNote = Math.abs(pitch - locked) <= 1.15 && frame.time - current.end <= 0.12
    if (sameNote) {
      if (pending.length) current.pitches.push(...pending)
      pending = []
      current.pitches.push(pitch)
      current.end = frame.time + hopSeconds
      const splitAt = splitForNewPitch(current.pitches)
      if (splitAt > 0) {
        const moved = current.pitches.slice(splitAt)
        current.pitches = current.pitches.slice(0, splitAt)
        current.end -= hopSeconds * moved.length
        close()
        current = { pitches: moved, start: frame.time - hopSeconds * (moved.length - 1), end: frame.time + hopSeconds }
      }
      continue
    }
    pending.push(pitch)
    if (pending.length < 3) continue
    close()
    current = {
      pitches: pending,
      start: frame.time - hopSeconds * (pending.length - 1),
      end: frame.time + hopSeconds,
    }
    pending = []
  }
  close()

  const merged: { pitch: number; start: number; duration: number }[] = []
  for (const note of notes) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.pitch - note.pitch) < 0.55 && note.start - (last.start + last.duration) < 0.1) {
      const span = last.duration + (note.end - note.start)
      last.pitch = (last.pitch * last.duration + note.pitch * (note.end - note.start)) / span
      last.duration = note.end - last.start
      continue
    }
    merged.push({ pitch: note.pitch, start: note.start, duration: note.end - note.start })
  }
  return merged
}

function splitForNewPitch(pitches: number[]): number {
  const recentCount = 18
  if (pitches.length < recentCount + 16) return 0
  const earlier = median(pitches.slice(0, -recentCount))
  const recent = pitches.slice(-recentCount)
  const recentMedian = median(recent)
  const settled = recent.every((pitch) => Math.abs(pitch - earlier) > 0.85)
  if (settled && Math.abs(recentMedian - earlier) > 0.9) return pitches.length - recentCount
  return 0
}

function dwellPitch(pitches: number[]): number {
  if (pitches.length < 8) return median(pitches)
  const start = Math.floor(pitches.length * 0.2)
  const end = Math.max(start + 1, Math.ceil(pitches.length * 0.85))
  return median(pitches.slice(start, end))
}

function mpm(frame: Float32Array, sampleRate: number): { freq: number; clarity: number } | null {
  const tauMin = Math.max(2, Math.floor(sampleRate / 1000))
  const tauMax = Math.min(Math.floor(sampleRate / 70), frame.length - 2)
  if (tauMax <= tauMin + 2) return null
  const windowed = hann(frame)
  const nsdf = new Float32Array(tauMax + 1)
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let correlation = 0
    let power = 0
    const limit = windowed.length - tau
    for (let index = 0; index < limit; index++) {
      const left = windowed[index]
      const right = windowed[index + tau]
      correlation += left * right
      power += left * left + right * right
    }
    nsdf[tau] = power > 0 ? (2 * correlation) / power : 0
  }

  let bestHeight = 0
  const peaks: { tau: number; height: number }[] = []
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (nsdf[tau] <= nsdf[tau - 1] || nsdf[tau] < nsdf[tau + 1] || nsdf[tau] <= 0) continue
    const delta = parabolaDelta(nsdf[tau - 1], nsdf[tau], nsdf[tau + 1])
    peaks.push({ tau: tau + delta, height: nsdf[tau] })
    if (nsdf[tau] > bestHeight) bestHeight = nsdf[tau]
  }
  if (bestHeight < 0.72 || !peaks.length) return null
  const candidates = peaks.filter((peak) => peak.height >= bestHeight * 0.8)
  let chosen = candidates[0]
  let bestScore = -Infinity
  for (const peak of candidates) {
    const freq = sampleRate / peak.tau
    if (freq < 70 || freq > 1000) continue
    const score = harmonicScore(windowed, sampleRate, freq) + peak.height
    if (score > bestScore) {
      bestScore = score
      chosen = peak
    }
  }
  if (!chosen || chosen.tau <= 0) return null
  return { freq: sampleRate / chosen.tau, clarity: chosen.height }
}

function harmonicScore(frame: Float32Array, sampleRate: number, freq: number): number {
  const fundamental = spectralEnergy(frame, sampleRate, freq)
  const octave = spectralEnergy(frame, sampleRate, freq / 2)
  let score = fundamental
  for (const harmonic of [2, 3, 4]) score += spectralEnergy(frame, sampleRate, freq * harmonic) / harmonic
  if (freq / 2 >= 70) score -= octave * 1.35
  return score
}

function spectralEnergy(frame: Float32Array, sampleRate: number, freq: number): number {
  const omega = (2 * Math.PI * freq) / sampleRate
  let real = 0
  let imag = 0
  for (let index = 0; index < frame.length; index++) {
    real += frame[index] * Math.cos(omega * index)
    imag -= frame[index] * Math.sin(omega * index)
  }
  return real * real + imag * imag
}

function hann(frame: Float32Array): Float32Array {
  const windowed = new Float32Array(frame.length)
  const last = Math.max(1, frame.length - 1)
  for (let index = 0; index < frame.length; index++) {
    const weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / last)
    windowed[index] = frame[index] * weight
  }
  return windowed
}

function parabolaDelta(previous: number, current: number, next: number): number {
  const denominator = previous - 2 * current + next
  if (denominator === 0) return 0
  return (0.5 * (previous - next)) / denominator
}

function continuousMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function highpass(input: Float32Array, sampleRate: number, cutoff: number): Float32Array {
  const alpha = 1 / (1 + 2 * Math.PI * cutoff * (1 / sampleRate))
  const output = new Float32Array(input.length)
  let previousIn = 0
  let previousOut = 0
  for (let index = 0; index < input.length; index++) {
    const next = alpha * (previousOut + input[index] - previousIn)
    output[index] = next
    previousOut = next
    previousIn = input[index]
  }
  return output
}

function rms(frame: Float32Array): number {
  let sum = 0
  for (let index = 0; index < frame.length; index++) sum += frame[index] * frame[index]
  return Math.sqrt(sum / frame.length)
}

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input
  const ratio = inRate / outRate
  const length = Math.floor(input.length / ratio)
  const output = new Float32Array(length)
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let cursor = start; cursor < end; cursor++) sum += input[cursor]
    output[index] = sum / Math.max(1, end - start)
  }
  return output
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
