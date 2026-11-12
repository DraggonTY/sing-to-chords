/**
 * Simulated-singer benchmark for the whole app pipeline: known tunes are "sung"
 * against the click by a seeded imperfect singer, then transcribed, analysed and
 * quantized exactly as the app does. A note counts when the right key lands on
 * the right sixteenth. A singer who is nearly a quarter-tone from A440 has no
 * single correct absolute key, so a take may be scored one semitone up or down
 * as a whole (the tune and its chords are then right, in a neighbouring key).
 *
 * node scripts/benchmark-singer.ts [--takes 64] [--quantize 16] [--free] [--drift]
 *
 * --free hides the click and the tempo: the app must find the beat from the
 * singing. A take then counts notes after the best whole-beat shift, because
 * which beat is "one" is a separate question (reported as bar line right).
 * --drift lets the singer's tempo wander by several percent, as it does without a click.
 *
 * This measures recovery of the INTENDED tune, which the vocadito benchmark
 * cannot (its references are sung pitch, not intended notes). The singer is a
 * model: off-A440 tuning, drift, per-note pitch error, scoops, vibrato, late
 * and uneven entries, consonant gaps, legato slides, breath noise. It does not
 * replace real recordings.
 */
import { analysisFromNotes, analyzeFreely, applyQuantize, type QuantizeDivision } from '../src/music/analyze.ts'
import { extractSingingNotes } from '../src/music/pitch.ts'

type Tune = { name: string; mode: 'major' | 'minor'; notes: Array<[number, number, number]> }
// [scale-relative midi from tonic 60, start beat, duration beats]
const line = (text: string): Array<[number, number, number]> => {
  let beat = 0
  return text.trim().split(/\s+/).flatMap((token): Array<[number, number, number]> => {
    const [pitch, length] = token.split(':')
    const duration = Number(length)
    const start = beat
    beat += duration
    return pitch === 'r' ? [] : [[Number(pitch), start, duration]]
  })
}
const TUNES: Tune[] = [
  { name: 'Twinkle', mode: 'major', notes: line('60:1 60:1 67:1 67:1 69:1 69:1 67:2 65:1 65:1 64:1 64:1 62:1 62:1 60:2') },
  { name: 'Ode to Joy', mode: 'major', notes: line('64:1 64:1 65:1 67:1 67:1 65:1 64:1 62:1 60:1 60:1 62:1 64:1 64:1.5 62:0.5 62:2') },
  { name: 'Frere Jacques', mode: 'major', notes: line('60:1 62:1 64:1 60:1 60:1 62:1 64:1 60:1 64:1 65:1 67:2 64:1 65:1 67:2 67:0.5 69:0.5 67:0.5 65:0.5 64:1 60:1') },
  { name: 'Happy Birthday', mode: 'major', notes: line('r:2 55:0.75 55:0.25 57:1 55:1 60:1 59:2 55:0.75 55:0.25 57:1 55:1 62:1 60:2') },
  { name: 'Amazing Grace', mode: 'major', notes: line('r:2 55:1 60:2 64:0.5 60:0.5 64:2 62:1 60:2 57:1 55:2 55:1 60:2 64:0.5 60:0.5 64:2 62:1 67:3') },
  { name: 'Greensleeves', mode: 'minor', notes: line('r:2 60:1 63:2 65:1 67:1.5 68:0.5 67:1 65:2 62:1 58:1.5 60:0.5 62:1 63:2 60:1 60:1.5 59:0.5 60:1 62:2 59:1 55:2') },
  { name: 'Scarborough Fair', mode: 'minor', notes: line('60:2 60:1 67:1 67:1 67:1 62:1.5 63:0.5 62:1 60:3 r:1 67:1 70:1 72:2 70:1 67:1 69:1 65:1 67:3') },
  { name: 'When the Saints', mode: 'major', notes: line('r:1 60:1 64:1 65:1 67:4 r:1 60:1 64:1 65:1 67:4 r:1 60:1 64:1 65:1 67:2 64:2 60:2 64:2 62:4') },
]

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const takes = Number(option('--takes', '64'))
const division = option('--quantize', '16') as QuantizeDivision
const free = args.includes('--free')
const drifting = args.includes('--drift')
const rate = 16000

function random(seed: number) {
  let state = seed >>> 0
  const uniform = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, uniform()))) * Math.cos(2 * Math.PI * uniform())
  return { uniform, normal, between: (low: number, high: number) => low + (high - low) * uniform() }
}

function sing(tune: Tune, seed: number) {
  const rng = random(seed)
  const bpm = Math.round(rng.between(72, 126))
  const beat = 60 / bpm
  const transpose = Math.floor(rng.between(-7, 6))
  const tuning = rng.between(-0.45, 0.45) // the singer's reference vs A440, in semitones
  const lag = rng.between(0.02, 0.09) // capture latency plus habitual lateness
  const steadiness = rng.between(0.6, 1.4) // a shakier or steadier singer
  const intended = tune.notes.map(([midi, start, duration]) => ({ midi: midi + transpose, startBeat: start, durationBeats: duration }))
  const lastBeat = intended.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  // Without a click the pulse wanders: a slow random walk of the beat length.
  const clock = [0]
  let stretch = 1
  for (let step = 1; step <= Math.ceil(lastBeat * 4) + 8; step++) {
    if (drifting) stretch = Math.max(0.9, Math.min(1.1, stretch + rng.normal() * 0.006))
    clock.push(clock[step - 1] + (beat / 4) * stretch)
  }
  const timeOf = (beats: number) => { const at = Math.min(clock.length - 2, Math.floor(beats * 4)); return clock[at] + (beats * 4 - at) * (clock[at + 1] - clock[at]) }
  const samples = new Float32Array(Math.ceil((timeOf(lastBeat) + lag + 0.6) * rate))
  const harmonics = [0.5, 0.8, 0.45, 0.26, 0.15, 0.09, 0.06]
  let phase = 0
  let drift = 0
  let previousPitch: number | null = null
  let previousEnd = -1
  for (let index = 0; index < intended.length; index++) {
    const note = intended[index]
    drift = Math.max(-0.25, Math.min(0.25, drift + rng.normal() * 0.035))
    const target = note.midi + tuning + drift + rng.normal() * 0.17 * steadiness
    const start = Math.max(previousEnd + 0.03, timeOf(note.startBeat) + lag + rng.normal() * 0.024 * steadiness)
    const next = intended[index + 1]
    const legato = next !== undefined && Math.abs(next.startBeat - note.startBeat - note.durationBeats) < 1e-6 && rng.uniform() < 0.35
    // Detached notes stop for a consonant or breath; legato notes run into the next.
    const sounded = timeOf(note.startBeat + note.durationBeats) - timeOf(note.startBeat) - (legato ? 0 : rng.between(0.045, Math.min(0.14, note.durationBeats * beat * 0.35)))
    const end = start + Math.max(0.09, sounded)
    const connected = previousPitch !== null && start - previousEnd < 0.045
    const scoop = connected ? 0 : rng.uniform() < 0.45 ? rng.between(0.6, 2.2) : 0
    const scoopTime = rng.between(0.05, 0.11)
    const glideTime = rng.between(0.04, 0.09)
    const vibratoDepth = end - start > 0.5 ? rng.between(0.2, 0.6) * steadiness : 0
    const vibratoRate = rng.between(4.8, 6.3)
    const loudness = rng.between(0.16, 0.3)
    const from = previousPitch ?? target
    for (let sample = Math.floor(start * rate); sample < Math.floor(end * rate) && sample < samples.length; sample++) {
      const time = sample / rate - start
      let pitch = target
      if (connected && time < glideTime) pitch = from + (target - from) * (time / glideTime)
      else if (scoop && time < scoopTime) pitch = target - scoop * (1 - time / scoopTime) ** 2
      if (vibratoDepth && time > 0.22) pitch += vibratoDepth * Math.min(1, (time - 0.22) / 0.15) * Math.sin(2 * Math.PI * vibratoRate * time)
      if (end - start - time < 0.05 && !legato) pitch -= 0.5 * (1 - (end - start - time) / 0.05)
      phase += 2 * Math.PI * 440 * 2 ** ((pitch - 69) / 12) / rate
      let wave = 0
      for (let harmonic = 0; harmonic < harmonics.length; harmonic++) wave += harmonics[harmonic] * Math.sin(phase * (harmonic + 1) + harmonic * 0.2)
      const attack = connected ? Math.max(0.55, Math.min(1, time / 0.03)) : Math.min(1, time / 0.025)
      const release = legato ? 1 : Math.min(1, (end - start - time) / 0.04)
      samples[sample] += wave * loudness * attack * release
    }
    previousPitch = target
    previousEnd = end
  }
  for (let sample = 0; sample < samples.length; sample++) samples[sample] += (rng.uniform() * 2 - 1) * 0.004
  return { samples, bpm, meanBpm: 60 * lastBeat / timeOf(lastBeat), intended, tonic: ((60 + transpose) % 12 + 12) % 12 }
}

const grid = division === '8' ? 0.5 : 0.25
const totals = { intended: 0, detected: 0, right: 0, transposed: 0, keyRight: 0, takes: 0, perfect: 0 }
const keyMisses: string[] = []
const barLog: string[] = []
// The app lays out bars of four beats, so the bar line is only scored on tunes in 4/4.
const FOUR_FOUR = new Set(['Twinkle', 'Ode to Joy', 'Frere Jacques', 'When the Saints'])
const tempo = { right: 0, octave: 0, bar: 0, barTakes: 0, wrong: [] as string[] }
const stepLog: string[] = []
const perTune = new Map<string, { intended: number; right: number; detected: number }>()
const wrong: Record<string, number> = {}
for (let take = 0; take < takes; take++) {
  const tune = TUNES[take % TUNES.length]
  const { samples, bpm, meanBpm, intended, tonic } = sing(tune, 7919 * (take + 1))
  const analysis = free ? analyzeFreely(samples, rate) : analysisFromNotes(extractSingingNotes(samples, rate, bpm))
  let heard = applyQuantize(analysis.notes, division)
  if (free) {
    const ratio = analysis.bpm! / meanBpm
    if (Math.abs(ratio - 1) < 0.06) tempo.right++
    else if (Math.abs(ratio - 2) < 0.12 || Math.abs(ratio - 0.5) < 0.03) tempo.octave++
    else tempo.wrong.push(`${tune.name} ${meanBpm.toFixed(0)}->${analysis.bpm}`)
    // Which beat is "one" is scored separately: allow a whole-beat shift.
    const at = (move: number) => intended.filter((note) => heard.some((candidate) => Math.abs(candidate.startBeat + move - note.startBeat) < 1e-6)).length
    let move = 0
    for (let candidate = -12; candidate <= 12; candidate++) if (at(candidate) > at(move)) move = candidate
    if (FOUR_FOUR.has(tune.name)) { tempo.barTakes++; if (move % 4 === 0) tempo.bar++ }
    if (args.includes("--verbose")) barLog.push(`${tune.name}:${((move % 4) + 4) % 4}`)
    heard = heard.map((note) => ({ ...note, startBeat: note.startBeat + move }))
  }
  const count = (shift: number) => intended.filter((note) => heard.some((candidate) => candidate.midi + shift === note.midi && Math.abs(candidate.startBeat - note.startBeat) < 1e-6)).length
  const shift = [0, 1, -1].reduce((best, candidate) => count(candidate) > count(best) ? candidate : best, 0)
  if (shift) totals.transposed++
  const detected = heard.map((note) => ({ ...note, midi: note.midi + shift }))
  const used = new Set<number>()
  let right = 0
  for (const note of intended) {
    const index = detected.findIndex((candidate, at) => !used.has(at) && candidate.midi === note.midi && Math.abs(candidate.startBeat - note.startBeat) < 1e-6)
    if (index >= 0) { used.add(index); right++; continue }
    const sameSlot = detected.find((candidate) => Math.abs(candidate.startBeat - note.startBeat) < 1e-6)
    const nearby = detected.find((candidate) => candidate.midi === note.midi && Math.abs(candidate.startBeat - note.startBeat) <= grid + 1e-6)
    if (!sameSlot && nearby && args.includes('--verbose')) stepLog.push(`${take}:${nearby.startBeat > note.startBeat ? 'late' : 'early'}:${note.durationBeats}`)
    const reason = sameSlot ? `wrong pitch by ${Math.abs(sameSlot.midi - note.midi) === 1 ? 'a semitone' : 'more'}` : nearby ? 'right pitch, one grid step off' : 'missing'
    wrong[reason] = (wrong[reason] ?? 0) + 1
  }
  totals.intended += intended.length
  totals.detected += detected.length
  totals.right += right
  totals.takes++
  if (right === intended.length && detected.length === intended.length) totals.perfect++
  if ((analysis.key.tonic + shift + 12) % 12 === tonic && analysis.key.mode === tune.mode) totals.keyRight++
  else keyMisses.push(`${tune.name}: ${analysis.key.tonic + shift - tonic} ${analysis.key.mode}`)
  const entry = perTune.get(tune.name) ?? { intended: 0, right: 0, detected: 0 }
  entry.intended += intended.length; entry.right += right; entry.detected += detected.length
  perTune.set(tune.name, entry)
}
const percent = (value: number) => `${(value * 100).toFixed(1)}%`
const recall = totals.right / totals.intended
const precision = totals.right / Math.max(1, totals.detected)
console.log(`simulated singer, ${totals.takes} takes, quantize ${division}${free ? ', no click (tempo hidden)' : ''}${drifting ? ', drifting tempo' : ''}`)
if (free) console.log(`  tempo found ${tempo.right}/${totals.takes}   double or half ${tempo.octave}   wrong ${tempo.wrong.length}   bar line right ${tempo.bar}/${tempo.barTakes} (4/4 tunes)${args.includes('--verbose') ? '\n  wrong tempos: ' + tempo.wrong.join('; ') : ''}`)
console.log(`  intended notes right (pitch and sixteenth): ${percent(recall)}  (${totals.right}/${totals.intended})`)
console.log(`  detected notes that are right:              ${percent(precision)}  (${totals.detected - totals.right} extra or wrong)`)
console.log(`  F1 ${percent(2 * precision * recall / (precision + recall))}   perfect takes ${totals.perfect}/${totals.takes}   key right ${totals.keyRight}/${totals.takes}   scored a semitone away ${totals.transposed}/${totals.takes}`)
if (args.includes('--verbose')) console.log(`  key misses: ${keyMisses.join('; ')}\n  grid-step misses (take:direction:length): ${stepLog.join(' ')}`)
console.log(`  misses: ${Object.entries(wrong).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason} ${count}`).join('; ')}`)
if (barLog.length) { const tally: Record<string, number> = {}; for (const item of barLog) tally[item] = (tally[item] ?? 0) + 1; console.log("  bar shift needed (tune:beats): " + Object.entries(tally).sort().map(([k, v]) => `${k} x${v}`).join("; ")) }
for (const [name, entry] of perTune) console.log(`  ${name.padEnd(18)} right ${percent(entry.right / entry.intended)}  extra/wrong ${entry.detected - entry.right}`)
