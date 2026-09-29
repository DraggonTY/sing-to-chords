import { analysisFromNotes, type Analysis } from './analyze.ts'
import type { RawNote } from './theory.ts'

const RATE = 16000
const WINDOW = 1024
const HOP = 160

type Candidate = { midi: number; score: number }

export async function transcribeSinging(samples: Float32Array, sampleRate: number, bpm: number): Promise<Analysis> {
  const audio = normalize(resample(samples, sampleRate, RATE))
  const frames = pitchFrames(audio)
  const path = decode(frames)
  return analysisFromNotes(toMelody(segment(path), bpm))
}

function pitchFrames(audio: Float32Array): Candidate[][] {
  const frames: Candidate[][] = []
  const energies: number[] = []
  for (let offset = 0; offset + WINDOW < audio.length; offset += HOP) {
    const frame = audio.subarray(offset, offset + WINDOW)
    const energy = rms(frame)
    energies.push(energy)
    frames.push(yinCandidates(frame, RATE))
  }
  const sorted = [...energies].sort((a, b) => a - b)
  const floor = Math.max(0.012, (sorted[Math.floor(sorted.length * 0.72)] ?? 0) * 0.28)
  return frames.map((candidates, index) => (energies[index] < floor ? [] : candidates))
}

function yinCandidates(frame: Float32Array, rate: number): Candidate[] {
  const tauMin = Math.max(2, Math.floor(rate / 1100))
  const tauMax = Math.min(frame.length >> 1, Math.floor(rate / 60))
  const diff = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    const limit = frame.length - tau
    for (let index = 0; index < limit; index++) {
      const delta = frame[index] - frame[index + tau]
      sum += delta * delta
    }
    diff[tau] = sum
  }
  const cmndf = new Float32Array(tauMax + 1)
  cmndf[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]
    cmndf[tau] = running > 0 ? (diff[tau] * tau) / running : 1
  }

  const found: Candidate[] = []
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (cmndf[tau] > cmndf[tau - 1] || cmndf[tau] > cmndf[tau + 1] || cmndf[tau] > 0.42) continue
    const shift = parabola(cmndf[tau - 1], cmndf[tau], cmndf[tau + 1])
    const freq = rate / (tau + shift)
    const midi = 69 + 12 * Math.log2(freq / 440)
    if (midi < 40 || midi > 84) continue
    found.push({ midi, score: 1 - cmndf[tau] })
  }
  const pruned = found.filter((candidate) => {
    const harmonic = found.find((other) => Math.abs(other.midi - (candidate.midi + 12)) < 0.7)
    return !harmonic || candidate.score > harmonic.score + 0.08
  })
  pruned.sort((a, b) => b.score - a.score)
  const kept: Candidate[] = []
  for (const candidate of pruned) {
    if (kept.some((other) => Math.abs(other.midi - candidate.midi) < 0.45)) continue
    kept.push(candidate)
    if (kept.length === 4) break
  }
  return kept
}

function decode(frames: Candidate[][]): Array<number | null> {
  const options = frames.map((candidates) => {
    const best = candidates[0]?.score ?? 0
    return [
      ...candidates.map((candidate) => ({ midi: candidate.midi as number | null, score: Math.log(candidate.score + 0.04) })),
      { midi: null as number | null, score: Math.log(best < 0.62 ? 0.72 : 0.06) },
    ]
  })
  const dp: number[][] = []
  const back: number[][] = []
  options.forEach((choices, index) => {
    dp[index] = []
    back[index] = []
    choices.forEach((choice, choiceIndex) => {
      if (index === 0) {
        dp[index][choiceIndex] = choice.score
        back[index][choiceIndex] = -1
        return
      }
      let best = -Infinity
      let from = 0
      options[index - 1].forEach((previous, previousIndex) => {
        const total = dp[index - 1][previousIndex] + transition(previous.midi, choice.midi) + choice.score
        if (total > best) {
          best = total
          from = previousIndex
        }
      })
      dp[index][choiceIndex] = best
      back[index][choiceIndex] = from
    })
  })
  const path: Array<number | null> = new Array(options.length)
  let cursor = 0
  const last = dp[dp.length - 1] ?? []
  last.forEach((score, index) => {
    if (score > (last[cursor] ?? -Infinity)) cursor = index
  })
  for (let index = options.length - 1; index >= 0; index--) {
    path[index] = options[index]?.[cursor]?.midi ?? null
    cursor = back[index]?.[cursor] ?? 0
  }
  return path
}

function transition(from: number | null, to: number | null): number {
  if (from == null && to == null) return -0.15
  if (from == null || to == null) return -1.5
  const distance = Math.abs(from - to)
  if (distance < 0.6) return 0.15
  if (distance < 1.4) return -0.35
  if (distance < 2.4) return -1.3
  if (Math.abs(distance - 12) < 0.8) return -3.4
  return -4.2
}

function segment(path: Array<number | null>): Array<{ pitch: number; start: number; duration: number }> {
  const hop = HOP / RATE
  const notes: Array<{ pitch: number; start: number; end: number }> = []
  let pitches: number[] = []
  let start = 0
  let end = 0
  const close = () => {
    if (pitches.length < 4) {
      pitches = []
      return
    }
    const duration = end - start
    if (duration >= 0.09) notes.push({ pitch: median(pitches), start, end })
    pitches = []
  }
  path.forEach((midi, index) => {
    const time = index * hop
    if (midi == null) {
      if (pitches.length && time - end > 0.06) close()
      return
    }
    if (!pitches.length) {
      pitches = [midi]
      start = time
      end = time + hop
      return
    }
    const center = median(pitches)
    if (Math.abs(midi - center) <= 0.85 && time - end <= 0.1) {
      pitches.push(midi)
      end = time + hop
      return
    }
    close()
    pitches = [midi]
    start = time
    end = time + hop
  })
  close()

  const merged: Array<{ pitch: number; start: number; duration: number }> = []
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
  for (let index = 1; index < merged.length; index++) {
    const previous = merged[index - 1]
    const note = merged[index]
    if (note.duration >= 0.5) continue
    if (Math.abs(note.pitch + 12 - previous.pitch) < 1) note.pitch += 12
    else if (Math.abs(note.pitch - 12 - previous.pitch) < 1) note.pitch -= 12
  }
  return merged.filter((note, index) => {
    const previous = merged[index - 1]
    const next = merged[index + 1]
    if (!previous || !next || note.duration >= 0.18) return true
    const rising = note.pitch > previous.pitch && note.pitch < next.pitch
    const falling = note.pitch < previous.pitch && note.pitch > next.pitch
    return !(rising || falling)
  })
}

function toMelody(events: Array<{ pitch: number; start: number; duration: number }>, bpm: number): RawNote[] {
  return events.map((note, index) => {
    const midi = Math.round(note.pitch)
    const startBeat = round3(Math.max(0, (note.start * bpm) / 60))
    const durationBeats = round3(Math.max(0.25, (note.duration * bpm) / 60))
    return { id: `n${index}-${midi}-${Math.round(startBeat * 100)}`, midi, startBeat, durationBeats }
  })
}

function parabola(left: number, center: number, right: number): number {
  const denominator = left - 2 * center + right
  if (Math.abs(denominator) < 1e-8) return 0
  return (left - right) / (2 * denominator)
}

function rms(frame: Float32Array): number {
  let sum = 0
  for (let index = 0; index < frame.length; index++) sum += frame[index] * frame[index]
  return Math.sqrt(sum / frame.length)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function normalize(input: Float32Array): Float32Array {
  let peak = 0
  for (let index = 0; index < input.length; index++) peak = Math.max(peak, Math.abs(input[index]))
  if (peak < 0.0008) return input
  const gain = 0.9 / peak
  const output = new Float32Array(input.length)
  for (let index = 0; index < input.length; index++) output[index] = input[index] * gain
  return output
}

function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length < 2) return input
  const length = Math.max(1, Math.floor((input.length * outRate) / inRate))
  const output = new Float32Array(length)
  const scale = (input.length - 1) / Math.max(1, length - 1)
  for (let index = 0; index < length; index++) {
    const position = index * scale
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const mix = position - left
    output[index] = input[left] * (1 - mix) + input[right] * mix
  }
  return output
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
