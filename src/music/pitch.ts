import type { RawNote } from './theory.ts'

// YIN/MPM periodicity with threshold-weighted alternatives and temporal decoding.
// Inspired by pYIN; this is not a full implementation of that algorithm.
const RATE = 12000
const WINDOW = 768
const HOP = 120
const LOW_FREQUENCY = 55
const HIGH_FREQUENCY = 1300
const HOP_SECONDS = HOP / RATE

type Candidate = { midi: number; probability: number }
type Frame = { time: number; candidates: Candidate[] }
type PitchFrame = { time: number; pitch: number | null }
type Segment = { pitch: number; start: number; end: number }

/** Extract one sung melody, retaining the recording's original timing. */
export function extractSingingNotes(samples: Float32Array, sampleRate: number, bpm: number): RawNote[] {
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 384000) {
    throw new RangeError('Unsupported audio sample rate.')
  }
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('Tempo must be a positive number.')
  if (samples.length / sampleRate > 600) throw new RangeError('Please use a recording under 10 minutes.')
  if (samples.length / sampleRate < 0.07) return []
  const audio = prepareAudio(samples, sampleRate)
  const frames = measureFrames(audio)
  const notes = segmentNotes(decode(frames), samples.length / sampleRate)
  return notes.map((note, index) => {
    const midi = Math.round(note.pitch)
    const startBeat = round3(note.start * bpm / 60)
    const durationBeats = round3((note.end - note.start) * bpm / 60)
    return { id: `n${index}-${midi}-${Math.round(startBeat * 1000)}`, midi, startBeat, durationBeats }
  }).filter((note) => note.durationBeats > 0)
}

function prepareAudio(input: Float32Array, sampleRate: number): Float32Array {
  // Remove DC without normalizing near-silence into a note.
  let mean = 0
  for (const value of input) mean += Number.isFinite(value) ? value : 0
  mean /= input.length
  const clean = new Float32Array(input.length)
  for (let index = 0; index < input.length; index++) clean[index] = Number.isFinite(input[index]) ? input[index] - mean : 0
  const output = new Float32Array(Math.floor(input.length * RATE / sampleRate))
  if (sampleRate === RATE) output.set(clean)
  else {
    // Windowed-sinc low-pass interpolation prevents high harmonics/noise from
    // aliasing into the vocal range and handles input rates below RATE too.
    const scale = Math.min(1, RATE / sampleRate)
    const radius = Math.ceil(12 / scale)
    const cutoff = 0.45 * scale
    // Cache fractional-delay filters so each audio sample only needs multiplies.
    const phaseCount = 256
    const filters: Float32Array[] = []
    for (let phase = 0; phase < phaseCount; phase++) {
      const filter = new Float32Array(radius * 2 + 1)
      let total = 0
      for (let tap = 0; tap < filter.length; tap++) {
        const distance = phase / phaseCount + radius - tap
        if (Math.abs(distance) > radius) continue
        const angle = 2 * Math.PI * cutoff * distance
        const sinc = Math.abs(angle) < 1e-8 ? 1 : Math.sin(angle) / angle
        const window = 0.42 + 0.5 * Math.cos(Math.PI * distance / radius) + 0.08 * Math.cos(2 * Math.PI * distance / radius)
        filter[tap] = 2 * cutoff * sinc * window
        total += filter[tap]
      }
      for (let tap = 0; tap < filter.length; tap++) filter[tap] /= total
      filters.push(filter)
    }
    for (let index = 0; index < output.length; index++) {
      const position = index * sampleRate / RATE
      const base = Math.floor(position)
      const filter = filters[Math.min(phaseCount - 1, Math.floor((position - base) * phaseCount))]
      let sum = 0
      const first = Math.max(0, radius - base)
      const last = Math.min(filter.length, clean.length - base + radius)
      for (let tap = first; tap < last; tap++) {
        sum += clean[base - radius + tap] * filter[tap]
      }
      output[index] = sum
    }
  }
  const alpha = 1 / (1 + 2 * Math.PI * 35 / RATE)
  let previousInput = 0
  let previousOutput = 0
  for (let index = 0; index < output.length; index++) {
    const value = output[index]
    previousOutput = alpha * (previousOutput + value - previousInput)
    output[index] = previousOutput
    previousInput = value
  }
  return output
}

function measureFrames(audio: Float32Array): Frame[] {
  const frames: Frame[] = []
  const frame = new Float32Array(WINDOW)
  const energies: number[] = []
  for (let center = 0; center < audio.length; center += HOP) {
    let power = 0
    const start = Math.max(0, center - HOP / 2)
    const end = Math.min(audio.length, center + HOP / 2)
    for (let index = start; index < end; index++) power += audio[index] * audio[index]
    energies.push(Math.sqrt(power / Math.max(1, end - start)))
  }
  const sorted = [...energies].sort((a, b) => a - b)
  // A relative gate retains soft phrases; periodicity rejects even loud breath.
  const gate = Math.max(0.00003, (sorted[Math.floor(sorted.length * 0.9)] ?? 0) * 0.018)
  for (let index = 0; index < energies.length; index++) {
    const center = index * HOP
    let candidates: Candidate[] = []
    if (energies[index] >= gate) {
      frame.fill(0)
      const offset = center - WINDOW / 2
      const start = Math.max(0, offset)
      const end = Math.min(audio.length, offset + WINDOW)
      frame.set(audio.subarray(start, end), start - offset)
      candidates = pitchCandidates(frame)
    }
    frames.push({ time: center / RATE, candidates })
  }
  return frames
}

function pitchCandidates(frame: Float32Array): Candidate[] {
  const maxLag = Math.ceil(RATE / LOW_FREQUENCY) + 1
  const difference = new Float64Array(maxLag + 1)
  const clarity = new Float64Array(maxLag + 1)
  let running = 0
  for (let lag = 1; lag <= maxLag; lag++) {
    let squaredDifference = 0
    let power = 0
    // Untapered, symmetric differences avoid the pitch bias introduced by a
    // Hann window on a time-domain periodicity detector.
    for (let index = 0; index < frame.length - lag; index++) {
      const left = frame[index]
      const right = frame[index + lag]
      const delta = left - right
      squaredDifference += delta * delta
      power += left * left + right * right
    }
    clarity[lag] = power > 1e-16 ? 1 - squaredDifference / power : 0
    const meanDifference = squaredDifference / (frame.length - lag)
    running += meanDifference
    difference[lag] = running > 1e-16 ? meanDifference * lag / running : 1
  }
  const troughs: Array<{ midi: number; value: number; clarity: number; probability: number }> = []
  for (let lag = 2; lag < maxLag; lag++) {
    if (difference[lag] >= difference[lag - 1] || difference[lag] > difference[lag + 1]) continue
    const shift = parabola(difference[lag - 1], difference[lag], difference[lag + 1])
    const frequency = RATE / (lag + shift)
    const value = difference[lag] - 0.25 * (difference[lag - 1] - difference[lag + 1]) * shift
    if (frequency < LOW_FREQUENCY || value > 0.5 || clarity[lag] < 0.55) continue
    troughs.push({ midi: 69 + 12 * Math.log2(frequency / 440), value: Math.max(0, value), clarity: clarity[lag], probability: 0 })
  }
  if (!troughs.length) return []
  // Beta(2,18) threshold prior rather than one hard YIN cutoff. First acceptable
  // periods receive mass; multiples don't get the same score just because every
  // periodic signal also repeats after 2T or 3T.
  for (let index = 1; index <= 50; index++) {
    const threshold = index / 100
    const mass = threshold * (1 - threshold) ** 17
    const trough = troughs.find((candidate) => candidate.value < threshold)
    if (trough) trough.probability += mass
  }
  const assignedMass = troughs.reduce((sum, trough) => sum + trough.probability, 0)
  if (assignedMass === 0) return []
  // Out-of-range periods still consume their threshold mass. Otherwise a high
  // whistle is incorrectly reported at an in-range subharmonic of its period.
  return troughs.filter((trough) => 440 * 2 ** ((trough.midi - 69) / 12) <= HIGH_FREQUENCY)
    .map((trough) => ({
      midi: trough.midi,
      // The threshold distribution chooses among periods; NSDF measures whether
      // there is a voice. Conflating these discards a clear melody in moderate
      // broadband noise just because every difference minimum rises together.
      probability: trough.probability / assignedMass * Math.max(0, Math.min(0.985, (trough.clarity - 0.5) / 0.4)),
    }))
    .filter((candidate) => candidate.probability > 0.002)
    .sort((a, b) => b.probability - a.probability).slice(0, 5)
}

function decode(frames: Frame[]): PitchFrame[] {
  type State = { pitch: number | null; emission: number }
  const states: State[][] = frames.map((frame) => {
    const voiced = frame.candidates.reduce((sum, candidate) => sum + candidate.probability, 0)
    return [
      ...frame.candidates.map((candidate) => ({ pitch: candidate.midi, emission: Math.log(Math.max(1e-8, candidate.probability)) })),
      { pitch: null, emission: Math.log(Math.max(0.015, 1 - voiced)) },
    ]
  })
  const backs: number[][] = []
  let previousScores: number[] = []
  for (let index = 0; index < states.length; index++) {
    const choices = states[index]
    const scores: number[] = []
    backs[index] = []
    for (let target = 0; target < choices.length; target++) {
      let best = -Infinity
      let bestSource = 0
      if (index === 0) best = 0
      else for (let source = 0; source < states[index - 1].length; source++) {
        const from = states[index - 1][source].pitch
        const to = choices[target].pitch
        let transition = 0
        if (from === null || to === null) transition = from === to ? 0 : -1.5
        else transition = -Math.min(3.5, Math.abs(from - to) * 0.22)
        const score = previousScores[source] + transition
        if (score > best) { best = score; bestSource = source }
      }
      scores.push(best + choices[target].emission)
      backs[index].push(bestSource)
    }
    const maximum = Math.max(...scores)
    previousScores = scores.map((score) => score - maximum)
  }
  let cursor = previousScores.indexOf(Math.max(...previousScores))
  const path: PitchFrame[] = new Array(frames.length)
  for (let index = frames.length - 1; index >= 0; index--) {
    path[index] = { time: frames[index].time, pitch: states[index][cursor].pitch }
    cursor = backs[index][cursor]
  }
  return path
}

function segmentNotes(frames: PitchFrame[], duration: number): Segment[] {
  // Median smoothing stays inside voiced regions and does not rewrite octaves.
  const smoothed = frames.map((frame, index) => {
    if (frame.pitch === null) return frame
    const pitches = frames.slice(Math.max(0, index - 1), index + 2)
      .filter((other) => other.pitch !== null && Math.abs(other.pitch - frame.pitch!) < 1.5)
      .map((other) => other.pitch!)
    return { ...frame, pitch: median(pitches) }
  })
  const notes: Segment[] = []
  let current: PitchFrame[] = []
  let pending: PitchFrame[] = []
  const close = () => {
    if (current.length >= 7) {
      const start = Math.max(0, current[0].time - HOP_SECONDS / 2)
      const end = Math.min(duration, current[current.length - 1].time + HOP_SECONDS / 2)
      if (end - start >= 0.065) {
        const pitches = current.map((frame) => frame.pitch!)
        const trim = Math.floor(pitches.length * 0.12)
        notes.push({ pitch: median(pitches.slice(trim, pitches.length - trim)), start, end })
      }
    }
    current = []
    pending = []
  }
  for (const frame of smoothed) {
    if (frame.pitch === null) {
      pending = []
      if (current.length && frame.time - current[current.length - 1].time >= 0.025) close()
      continue
    }
    if (!current.length) { current = [frame]; continue }
    const center = median(current.slice(-100).map((item) => item.pitch!))
    if (Math.abs(frame.pitch - center) <= 0.7) {
      current.push(...pending, frame)
      pending = []
      continue
    }
    if (pending.length && Math.sign(frame.pitch - center) !== Math.sign(pending[0].pitch! - center)) pending = []
    pending.push(frame)
    const pendingCenter = median(pending.slice(-7).map((item) => item.pitch!))
    const moved = Math.abs(pendingCenter - center)
    // Semitones settle for 70 ms; larger changes need 40 ms. This absorbs vibrato
    // but preserves chromatic steps and short, genuinely sung octave leaps.
    const needed = moved > 1.5 ? 4 : 7
    if (pending.length >= needed && (moved > 1.5 || Math.round(pendingCenter) !== Math.round(center))) {
      const next = pending
      close()
      current = next
    } else if (pending.length >= 12) {
      // Gentle detuning that never reaches a new note is still part of the
      // current note; don't leave an arbitrarily long, uncommitted tail.
      current.push(...pending)
      pending = []
    }
  }
  close()
  const merged: Segment[] = []
  for (const note of notes) {
    const previous = merged[merged.length - 1]
    // A settling pitch can split one sustained note early in its first vibrato
    // cycle. Join only touching equal notes, never notes separated by a rest.
    if (previous && Math.round(previous.pitch) === Math.round(note.pitch) && note.start - previous.end <= 0.010001) {
      const previousLength = previous.end - previous.start
      const length = note.end - note.start
      previous.pitch = (previous.pitch * previousLength + note.pitch * length) / (previousLength + length)
      previous.end = note.end
    } else merged.push(note)
  }
  return merged
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function parabola(left: number, center: number, right: number): number {
  const denominator = left - 2 * center + right
  return Math.abs(denominator) < 1e-12 ? 0 : Math.max(-0.5, Math.min(0.5, (left - right) / (2 * denominator)))
}

function round3(value: number): number { return Math.round(value * 1000) / 1000 }
