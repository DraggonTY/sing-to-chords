export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const

export type Mode = 'major' | 'minor'
export type Quality = 'maj' | 'min' | 'dim' | 'aug' | '7' | 'maj7' | 'min7'

export type KeySignature = {
  tonic: number
  mode: Mode
}

export type Chord = {
  id: string
  root: number
  quality: Quality
  symbol: string
  tones: number[]
}

export type RawNote = {
  id: string
  midi: number
  startBeat: number
  durationBeats: number
}

const INTERVALS: Record<Quality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
const MAJOR_QUALITIES: Quality[] = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim']
const MAJOR_WEIGHTS = [6, 3.2, 2.1, 5, 6, 4.7, 1.3]

const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]
const MINOR_QUALITIES: Quality[] = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj']
const MINOR_WEIGHTS = [6, 1.4, 3.4, 4.6, 3.2, 4.4, 3.6]

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12
}

export function noteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1
  return `${PITCH_NAMES[pitchClass(midi)]}${octave}`
}

export function keyName(key: KeySignature): string {
  return `${PITCH_NAMES[key.tonic]} ${key.mode}`
}

export function makeChord(root: number, quality: Quality): Chord {
  const pc = ((root % 12) + 12) % 12
  const tones = INTERVALS[quality].map((interval) => (pc + interval) % 12)
  return {
    id: `${pc}:${quality}`,
    root: pc,
    quality,
    symbol: chordSymbol(pc, quality),
    tones,
  }
}

export function chordById(id: string): Chord | null {
  const parts = id.split(':')
  if (parts.length !== 2 || !/^(?:[0-9]|1[01])$/.test(parts[0])) return null
  const [rootText, quality] = parts
  const root = Number(rootText)
  if (!Number.isInteger(root) || root < 0 || root > 11) return null
  if (!isQuality(quality)) return null
  return makeChord(root, quality)
}

export function keyFromMelody(notes: { pitch: number; weight: number }[]): { key: KeySignature; confidence: number } {
  const valid = notes.filter((note) => Number.isFinite(note.pitch) && Number.isFinite(note.weight) && note.weight > 0)
  const histogram = new Array<number>(12).fill(0)
  for (const note of valid) histogram[pitchClass(Math.round(note.pitch))] += note.weight
  const candidates = rankKeys(histogram)
  if (!valid.length) return { key: { tonic: 0, mode: 'major' }, confidence: 0 }

  // Phrase endpoints help distinguish relative keys with the same seven scale tones.
  // These are deliberately small priors: a final passing tone must not decide the key.
  const first = pitchClass(Math.round(valid[0].pitch))
  const last = pitchClass(Math.round(valid[valid.length - 1].pitch))
  for (const candidate of candidates) {
    if (first === candidate.key.tonic) candidate.score += 0.025
    if (last === candidate.key.tonic) candidate.score += 0.065
  }
  candidates.sort((a, b) => b.score - a.score)
  return { key: candidates[0].key, confidence: keyConfidence(histogram, candidates) }
}

export function intendedMidi(pitch: number, key: KeySignature): number {
  const chromatic = Math.round(pitch)
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
  let bestMidi = chromatic
  let bestDistance = Infinity
  const center = Math.round(pitch)
  for (let midi = center - 2; midi <= center + 2; midi++) {
    const degree = (((midi % 12) + 12) % 12 - key.tonic + 12) % 12
    if (!scale.includes(degree)) continue
    const distance = Math.abs(pitch - midi)
    if (distance < bestDistance) {
      bestDistance = distance
      bestMidi = midi
    }
  }
  const chromaticDistance = Math.abs(pitch - chromatic)
  if (bestDistance <= 0.72 && bestDistance <= chromaticDistance + 0.32) return bestMidi
  return chromatic
}

export type KeyCandidate = { key: KeySignature; score: number; correlation: number }

/** Duration-weighted Krumhansl–Schmuckler profiles, with a small scale-fit term. */
export function rankKeys(histogram: number[]): KeyCandidate[] {
  const clean = Array.from({ length: 12 }, (_, index) => {
    const value = histogram[index]
    return Number.isFinite(value) && value > 0 ? value : 0
  })
  const total = clean.reduce((sum, value) => sum + value, 0)
  const candidates: KeyCandidate[] = []
  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
    const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
    for (let tonic = 0; tonic < 12; tonic++) {
      const relative = clean.map((_, index) => clean[(tonic + index) % 12])
      const correlation = pearson(relative, profile)
      // Raised sixth and seventh are normal melodic/harmonic-minor vocabulary.
      const inScale = relative.reduce((sum, value, degree) => sum + value * (
        scale.includes(degree) ? 1 : mode === 'minor' && (degree === 9 || degree === 11) ? 0.7 : 0
      ), 0)
      candidates.push({ key: { tonic, mode }, correlation, score: correlation + (total ? 0.18 * inScale / total : 0) })
    }
  }
  return candidates.sort((a, b) => b.score - a.score)
}

export function detectKey(histogram: number[]): { key: KeySignature; confidence: number } {
  const candidates = rankKeys(histogram)
  return { key: candidates[0].key, confidence: keyConfidence(histogram, candidates) }
}

function keyConfidence(histogram: number[], candidates: KeyCandidate[]): number {
  const clean = histogram.slice(0, 12).map((value) => Number.isFinite(value) && value > 0 ? value : 0)
  const total = clean.reduce((sum, value) => sum + value, 0)
  if (!total) return 0
  const probabilities = clean.map((value) => value / total)
  const effectiveClasses = 1 / probabilities.reduce((sum, value) => sum + value * value, 0)
  const distinct = probabilities.filter((value) => value >= 0.025).length
  // One held note cannot establish a major/minor key, however perfect its tuning.
  const evidence = Math.min(1, Math.max(0, (effectiveClasses - 1) / 3), Math.max(0, (distinct - 1) / 3))
  const separation = Math.min(1, Math.max(0, (candidates[0].score - candidates[1].score) / 0.18))
  const fit = Math.min(1, Math.max(0, (candidates[0].correlation - 0.15) / 0.7))
  // This is a heuristic certainty score, not a calibrated probability.
  return Math.min(0.95, evidence * fit * separation)
}

export function rankChords(midi: number, key: KeySignature, previous: Chord | null): Chord[] {
  const pc = pitchClass(midi)
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
  const qualities = key.mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES
  const weights = key.mode === 'major' ? MAJOR_WEIGHTS : MINOR_WEIGHTS
  const scaleTones = new Set(scale.map((degree) => (key.tonic + degree) % 12))
  const scored = new Map<string, { chord: Chord; score: number }>()

  const consider = (chord: Chord, score: number) => {
    if (!chord.tones.includes(pc)) return
    const current = scored.get(chord.id)
    if (!current || score > current.score) scored.set(chord.id, { chord, score })
  }

  scale.forEach((degree, index) => {
    const root = (key.tonic + degree) % 12
    const quality = qualities[index]
    const weight = weights[index]
    consider(makeChord(root, quality), weight + toneRole(root, quality, pc))
    if (quality === 'maj') {
      consider(makeChord(root, 'maj7'), weight * 0.72 + toneRole(root, 'maj7', pc))
      if (degree === 7) consider(makeChord(root, '7'), weight * 0.92 + toneRole(root, '7', pc))
    } else if (quality === 'min') {
      consider(makeChord(root, 'min7'), weight * 0.72 + toneRole(root, 'min7', pc))
    }
  })

  if (key.mode === 'minor') {
    const dominant = (key.tonic + 7) % 12
    consider(makeChord(dominant, 'maj'), 5.6 + toneRole(dominant, 'maj', pc))
    consider(makeChord(dominant, '7'), 5.1 + toneRole(dominant, '7', pc))
  }

  if (scored.size === 0) {
    for (let root = 0; root < 12; root++) {
      for (const quality of ['maj', 'min', '7'] as const) {
        const chord = makeChord(root, quality)
        if (!chord.tones.includes(pc)) continue
        const inKey = chord.tones.filter((tone) => scaleTones.has(tone)).length
        let score = 1.4 + inKey * 0.55 + toneRole(root, quality, pc)
        if (root === pc) score += 0.8
        consider(chord, score)
      }
    }
  }

  for (const entry of scored.values()) {
    if (!previous) continue
    const distance = (entry.chord.root - previous.root + 12) % 12
    if (distance === 5 || distance === 7) entry.score += 1.05
    if (distance === 0) entry.score += 0.25
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.chord.symbol.localeCompare(b.chord.symbol))
    .slice(0, 8)
    .map((entry) => entry.chord)
}

export function rankChordsForGroup(
  notes: { midi: number; startBeat: number; durationBeats: number }[],
  key: KeySignature,
  previous: Chord | null,
): Chord[] {
  if (!notes.length) return [makeChord(key.tonic, key.mode === 'major' ? 'maj' : 'min')]
  const triads = diatonicTriads(key)
  const scored: { chord: Chord; score: number; covered: number }[] = []

  for (const triad of triads) {
    const covered = coveredDuration(triad.chord, notes)
    scored.push({
      chord: triad.chord,
      covered,
      score: scoreChord(triad.chord, triad.weight, notes, key, previous),
    })
  }

  for (const triad of triads) {
    const richer = seventhFor(triad.chord.quality)
    if (!richer) continue
    const chord = makeChord(triad.chord.root, richer)
    const covered = coveredDuration(chord, notes)
    const triadScore = scored.find((entry) => entry.chord.id === triad.chord.id)
    if (!triadScore || covered <= triadScore.covered + 0.2) continue
    scored.push({
      chord,
      covered,
      score: scoreChord(chord, triad.weight * 0.85, notes, key, previous) - 0.35,
    })
  }

  return scored
    .sort((a, b) => b.score - a.score || a.chord.symbol.localeCompare(b.chord.symbol))
    .slice(0, 8)
    .map((entry) => entry.chord)
}

/** A tonal palette; sevenths are available but the harmonizer charges for their complexity. */
export function chordPalette(key: KeySignature): Chord[] {
  const chords = new Map<string, Chord>()
  for (const { chord } of diatonicTriads(key)) {
    chords.set(chord.id, chord)
    const degree = pitchClass(chord.root - key.tonic)
    const dominantSeventh = degree === 7 || (key.mode === 'minor' && degree === 10)
    const quality = dominantSeventh && chord.quality === 'maj'
      ? '7'
      : seventhFor(chord.quality)
    if (quality) {
      const seventh = makeChord(chord.root, quality)
      chords.set(seventh.id, seventh)
    }
  }
  return [...chords.values()]
}

export function voiceChord(chord: Chord, previous: number[] | null = null): number[] {
  const pitchClasses = INTERVALS[chord.quality].map((interval) => (chord.root + interval) % 12)
  const prior = previous?.filter(Number.isFinite).slice().sort((a, b) => a - b) ?? []
  let best: number[] = []
  let bestCost = Infinity
  // Search inversions AND octaves. Restricting each inversion to one fixed octave
  // causes avoidable jumps and can make identical average pitches hide moving voices.
  for (let inversion = 0; inversion < pitchClasses.length; inversion++) {
    const closed = placeVoicing(pitchClasses, inversion)
    for (const shift of [-12, 0, 12]) {
      const candidate = closed.map((midi) => midi + shift)
      if (candidate[0] < 45 || candidate[candidate.length - 1] > 69) continue
      const center = candidate.reduce((sum, midi) => sum + midi, 0) / candidate.length
      const registerCost = Math.abs(center - 55) * 0.18 + Math.max(0, 48 - candidate[0]) * 0.65
      const cost = registerCost + (prior.length ? movementCost(candidate, prior) : inversion === 0 ? 0 : 0.65)
      if (cost < bestCost) {
        best = candidate
        bestCost = cost
      }
    }
  }
  return best
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.62) return 'strong match'
  if (confidence >= 0.35) return 'likely key'
  return 'unsure — try another key'
}

function chordSymbol(root: number, quality: Quality): string {
  const name = PITCH_NAMES[root]
  switch (quality) {
    case 'maj':
      return name
    case 'min':
      return `${name}m`
    case 'dim':
      return `${name}dim`
    case 'aug':
      return `${name}aug`
    case '7':
      return `${name}7`
    case 'maj7':
      return `${name}maj7`
    case 'min7':
      return `${name}m7`
  }
}

function diatonicTriads(key: KeySignature): { chord: Chord; weight: number }[] {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
  const qualities = key.mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES
  const weights = key.mode === 'major' ? MAJOR_WEIGHTS : MINOR_WEIGHTS
  const triads = scale.map((degree, index) => ({
    chord: makeChord((key.tonic + degree) % 12, qualities[index]),
    weight: weights[index],
  }))
  if (key.mode === 'minor') {
    triads.push({ chord: makeChord((key.tonic + 7) % 12, 'maj'), weight: 5.6 })
    triads.push({ chord: makeChord((key.tonic + 7) % 12, '7'), weight: 5.1 })
  }
  return triads
}

function seventhFor(quality: Quality): Quality | null {
  if (quality === 'maj') return 'maj7'
  if (quality === 'min') return 'min7'
  return null
}

function coveredDuration(chord: Chord, notes: { midi: number; durationBeats: number }[]): number {
  return notes.reduce((sum, note) => sum + (chord.tones.includes(pitchClass(note.midi)) ? note.durationBeats : 0), 0)
}

function scoreChord(
  chord: Chord,
  weight: number,
  notes: { midi: number; startBeat: number; durationBeats: number }[],
  key: KeySignature,
  previous: Chord | null,
): number {
  let score = weight * 0.45
  let importantMiss = 0
  let importantHit = 0
  for (const note of notes) {
    const onBeat = Math.abs(note.startBeat - Math.round(note.startBeat)) < 0.2
    const important = onBeat || note.durationBeats >= 1.2
    const tone = chord.tones.includes(pitchClass(note.midi))
    if (tone && important) {
      importantHit += 1
      score += 3.4 + note.durationBeats * 0.35
    } else if (tone) {
      score += 0.45 + note.durationBeats * 0.2
    } else if (important) {
      importantMiss += 1
      score -= 3.1
    }
  }
  if (importantMiss === 0 && importantHit > 0 && previous?.id === chord.id) score += 1.6
  const last = [...notes].sort((a, b) => b.startBeat + b.durationBeats - (a.startBeat + a.durationBeats))[0]
  const tonicQuality = key.mode === 'major' ? 'maj' : 'min'
  if (
    last &&
    pitchClass(last.midi) === key.tonic &&
    chord.root === key.tonic &&
    chord.quality === tonicQuality &&
    last.durationBeats >= 1
  ) {
    score += 1.5
  }
  if (previous && previous.id !== chord.id) {
    const distance = (chord.root - previous.root + 12) % 12
    if (distance === 5 || distance === 7) score += 0.7
  }
  return score
}

function placeVoicing(pitchClasses: number[], inversion: number): number[] {
  const order = pitchClasses.slice(inversion).concat(pitchClasses.slice(0, inversion))
  let bass = 36 + order[0]
  while (bass < 48) bass += 12
  if (bass > 57) bass -= 12
  const voiced = [bass]
  let cursor = bass
  for (let index = 1; index < order.length; index++) {
    let note = cursor + ((order[index] - (cursor % 12) + 12) % 12)
    if (note === cursor) note += 12
    voiced.push(note)
    cursor = note
  }
  return voiced
}

function movementCost(voiced: number[], previous: number[]): number {
  const motion = (left: number, right: number) => {
    const distance = Math.abs(left - right)
    return distance + Math.max(0, distance - 5) * 0.6
  }
  // Ordered sequence alignment preserves voice order when a seventh enters/leaves.
  // Equal-size chords pair voice-to-voice; centroid matching loses this information.
  if (voiced.length === previous.length) {
    return voiced.reduce((sum, midi, index) => sum + motion(midi, previous[index]), 0)
  }
  const costs = Array.from({ length: voiced.length + 1 }, () => new Array<number>(previous.length + 1).fill(Infinity))
  costs[0][0] = 0
  for (let row = 0; row <= voiced.length; row++) {
    for (let col = 0; col <= previous.length; col++) {
      if (row && col) costs[row][col] = Math.min(costs[row][col], costs[row - 1][col - 1] + motion(voiced[row - 1], previous[col - 1]))
      if (row) costs[row][col] = Math.min(costs[row][col], costs[row - 1][col] + 5)
      if (col) costs[row][col] = Math.min(costs[row][col], costs[row][col - 1] + 5)
    }
  }
  return costs[voiced.length][previous.length]
}

function toneRole(root: number, quality: Quality, pc: number): number {
  const interval = (pc - root + 12) % 12
  if (interval === 0) return 1.25
  if (INTERVALS[quality][1] === interval) return 0.45
  if (interval === 7) return 0.3
  return 0
}

function isQuality(value: string): value is Quality {
  return Object.hasOwn(INTERVALS, value)
}

function pearson(left: number[], right: number[]): number {
  const count = left.length
  let meanLeft = 0
  let meanRight = 0
  for (let index = 0; index < count; index++) {
    meanLeft += left[index]
    meanRight += right[index]
  }
  meanLeft /= count
  meanRight /= count
  let num = 0
  let leftSq = 0
  let rightSq = 0
  for (let index = 0; index < count; index++) {
    const a = left[index] - meanLeft
    const b = right[index] - meanRight
    num += a * b
    leftSq += a * a
    rightSq += b * b
  }
  if (leftSq === 0 || rightSq === 0) return 0
  return num / Math.sqrt(leftSq * rightSq)
}
