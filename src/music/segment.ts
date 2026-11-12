export type MelodyFrame = { time: number; pitch: number | null; energy?: number }
/** `pitch` is the note on the singer's own tuning grid; `sung` is the measured pitch. */
export type SungSegment = { pitch: number; start: number; end: number; sung?: number }
type VoicedFrame = MelodyFrame & { pitch: number }
type PitchRun = { start: number; stop: number; pitch: number }

const HALF_HOP = 0.005
const CHANGE_COST = 9
const MIN_FRAMES = 9

/** Turn a continuous vocal contour into notes, rather than quantizing every excursion. */
export function segmentSingingNotes(frames: MelodyFrame[], duration: number): SungSegment[] {
  const groups: VoicedFrame[][] = []
  let active: VoicedFrame[] = []
  for (const frame of frames) {
    if (frame.pitch === null) {
      // A dropped pitch estimate for 10–20 ms need not end a sung vowel.
      // Longer gaps remain rests; energy reattacks can still split equal notes.
      if (active.length && frame.time - active[active.length - 1].time >= 0.025) {
        groups.push(active)
        active = []
      }
    } else active.push(frame as VoicedFrame)
  }
  if (active.length) groups.push(active)
  return groups.flatMap((group) => partition(group, duration))
    .flatMap((note) => splitReattacks(note, frames))
}

function partition(sung: VoicedFrame[], duration: number): SungSegment[] {
  if (sung.length < MIN_FRAMES) return []
  // Decode on the singer's grid, not A440's: see phraseTuning.
  const offset = phraseTuning(sung)
  const group = offset ? sung.map((frame) => ({ ...frame, pitch: frame.pitch - offset })) : sung
  let low = Infinity
  let high = -Infinity
  for (const frame of group) {
    low = Math.min(low, Math.floor(frame.pitch))
    high = Math.max(high, Math.ceil(frame.pitch))
  }
  const count = high - low + 1
  const backs: Int16Array[] = []
  let previous: Float64Array | null = null
  for (const frame of group) {
    const scores = new Float64Array(count)
    const back = new Int16Array(count)
    for (let target = 0; target < count; target++) {
      let best = previous?.[target] ?? 0
      let source = target
      if (previous) {
        for (let candidate = 0; candidate < count; candidate++) {
          const cost = previous[candidate] + CHANGE_COST + Math.abs(candidate - target) * 0.05
          if (cost < best) { best = cost; source = candidate }
        }
      }
      // A bounded loss prevents one unreliable octave frame from creating a note.
      scores[target] = best + Math.min(4, (low + target - frame.pitch) ** 2)
      back[target] = source
    }
    backs.push(back)
    previous = scores
  }
  let cursor = 0
  for (let index = 1; index < count; index++) if (previous![index] < previous![cursor]) cursor = index
  const decoded = new Int16Array(group.length)
  for (let index = group.length - 1; index >= 0; index--) {
    decoded[index] = low + cursor
    cursor = backs[index][cursor]
  }

  // A short, stable neighbour note can outweigh fewer frames than the general
  // change penalty. Recover an interior plateau while excluding recurring
  // vibrato lobes in a long held note. This preserves quick semitone ornaments.
  for (const run of pitchRuns(decoded)) {
    if (run.stop - run.start > 70 || run.stop - run.start < 28) continue
    for (let start = run.start + 7; start < run.stop - 7;) {
      const pitch = Math.round(group[start].pitch)
      let stop = start + 1
      while (stop < run.stop && Math.round(group[stop].pitch) === pitch) stop++
      if (pitch !== run.pitch && stop - start >= 12 && run.stop - stop >= 7) decoded.fill(pitch, start, stop)
      start = stop
    }
  }

  const runs = pitchRuns(decoded)
  const slides = new Set<number>()
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]
    const before = runs[index - 1]
    const after = runs[index + 1]
    // A monotonic passage between settled notes is a glide. A short stable
    // note is retained, including one shorter than the glide itself.
    if (run.stop - run.start < 7 || run.stop - run.start >= 25 || !after
      || after.stop - after.start < 30 || (before && before.stop - before.start < 25)) continue
    if (!isGlide(group.slice(run.start + 1, run.stop - 1))) continue
    slides.add(index)
    if (!before) after.start = run.start
    else {
      let split = run.start
      while (split < run.stop && Math.abs(group[split].pitch - before.pitch) < Math.abs(group[split].pitch - after.pitch)) split++
      before.stop = split
      after.start = split
    }
  }
  return runs.filter((run, index) => !slides.has(index) && run.stop - run.start >= MIN_FRAMES)
    .map((run) => ({
      pitch: run.pitch + offset,
      sung: middlePitch(sung, run),
      start: Math.max(0, group[run.start].time - HALF_HOP),
      end: Math.min(duration, group[run.stop - 1].time + HALF_HOP),
    }))
}

function pitchRuns(decoded: Int16Array): PitchRun[] {
  const runs: PitchRun[] = []
  for (let index = 0; index < decoded.length; index++) {
    const previous = runs[runs.length - 1]
    if (!previous || previous.pitch !== decoded[index]) runs.push({ start: index, stop: index + 1, pitch: decoded[index] })
    else previous.stop = index + 1
  }
  return runs
}

function isGlide(frames: VoicedFrame[]): boolean {
  const meanTime = frames.reduce((sum, frame) => sum + frame.time, 0) / frames.length
  const meanPitch = frames.reduce((sum, frame) => sum + frame.pitch, 0) / frames.length
  let covariance = 0
  let timeVariance = 0
  let pitchVariance = 0
  for (const frame of frames) {
    covariance += (frame.time - meanTime) * (frame.pitch - meanPitch)
    timeVariance += (frame.time - meanTime) ** 2
    pitchVariance += (frame.pitch - meanPitch) ** 2
  }
  if (!timeVariance || !pitchVariance) return false
  const slope = covariance / timeVariance
  const fit = covariance ** 2 / (timeVariance * pitchVariance)
  const drift = Math.abs(frames[frames.length - 1].pitch - frames[0].pitch)
  return Math.abs(slope) > 5 && fit > 0.85 && drift > 0.5
}

function splitReattacks(note: SungSegment, frames: MelodyFrame[]): SungSegment[] {
  const inside = frames.filter((frame) => frame.time >= note.start && frame.time <= note.end)
  if (inside.length < 26 || inside.some((frame) => frame.energy === undefined)) return [note]
  // Average power across several pitch periods. A 10 ms RMS value alone beats
  // against low voices and can look like an articulation in a steady bass note.
  const energy = inside.map((_, index) => {
    const neighbours = inside.slice(Math.max(0, index - 1), index + 2)
    return Math.sqrt(neighbours.reduce((sum, frame) => sum + frame.energy! ** 2, 0) / neighbours.length)
  })
  const cuts: number[] = []
  for (let index = 10; index < inside.length - 10; index++) {
    if (energy[index] > energy[index - 1] || energy[index] >= energy[index + 1]) continue
    const before = Math.max(...energy.slice(index - 9, index - 2))
    const after = Math.max(...energy.slice(index + 3, index + 10))
    // Require a dip AND a recovery, relative to both surrounding vowels. A
    // quieter sustained phrase alone should not manufacture another onset.
    if (energy[index] > 0.6 * Math.min(before, after)) continue
    if (inside[index].time - (cuts[cuts.length - 1] ?? note.start) < 0.14) continue
    cuts.push(inside[index].time)
  }
  const edges = [note.start, ...cuts, note.end]
  return edges.slice(0, -1).map((start, index) => ({ ...note, start, end: edges[index + 1] }))
}

/**
 * Unaccompanied singers drift away from A440. Where the settled part of a
 * phrase sits between two keys, a fixed semitone grid flips one held note back
 * and forth between its neighbours. Measure how far the phrase's steady pitch
 * sits from the grid (a circular mean, so +49 and -49 cents agree).
 */
function phraseTuning(group: VoicedFrame[]): number {
  // Average across a vibrato cycle first: the instants where vibrato stands
  // still are its extremes, which sit well away from the note's centre.
  const reach = 10
  const centre = new Float64Array(group.length)
  let sum = 0
  let first = 0
  let last = 0
  for (let index = 0; index < group.length; index++) {
    while (last < group.length && last <= index + reach) sum += group[last++].pitch
    while (first < index - reach) sum -= group[first++].pitch
    centre[index] = sum / (last - first)
  }
  let x = 0
  let y = 0
  let count = 0
  for (let index = 3; index < group.length - 3; index++) {
    // Glides between notes say nothing about where the notes sit.
    if (Math.abs(centre[index + 3] - centre[index - 3]) > 0.12) continue
    const angle = 2 * Math.PI * centre[index]
    x += Math.cos(angle)
    y += Math.sin(angle)
    count++
  }
  // Without a consistent offset, keep the standard grid.
  if (count < 8 || Math.hypot(x, y) / count < 0.35) return 0
  return Math.atan2(y, x) / (2 * Math.PI)
}

function middlePitch(group: VoicedFrame[], run: PitchRun): number {
  const trim = Math.floor((run.stop - run.start) * 0.2)
  const middle: number[] = []
  for (let index = run.start + trim; index < run.stop - trim; index++) middle.push(group[index].pitch)
  middle.sort((a, b) => a - b)
  return middle[Math.floor(middle.length / 2)]
}
