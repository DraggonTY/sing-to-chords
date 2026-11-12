/**
 * Key detection on well-known melodies, given as exact notes (no audio), each
 * in all 12 transpositions. `npm run benchmark:key`
 * [pitch relative to the tonic at 0 : length in beats]; r = rest.
 */
import { analysisFromNotes } from '../src/music/analyze.ts'
import type { RawNote } from '../src/music/theory.ts'

const TUNES: Array<[string, 'major' | 'minor', string]> = [
  ['Twinkle Twinkle', 'major', '0:1 0:1 7:1 7:1 9:1 9:1 7:2 5:1 5:1 4:1 4:1 2:1 2:1 0:2'],
  ['Ode to Joy', 'major', '4:1 4:1 5:1 7:1 7:1 5:1 4:1 2:1 0:1 0:1 2:1 4:1 4:1.5 2:.5 2:2 4:1 4:1 5:1 7:1 7:1 5:1 4:1 2:1 0:1 0:1 2:1 4:1 2:1.5 0:.5 0:2'],
  ['Frere Jacques', 'major', '0:1 2:1 4:1 0:1 0:1 2:1 4:1 0:1 4:1 5:1 7:2 4:1 5:1 7:2'],
  ['Happy Birthday', 'major', '-5:.75 -5:.25 -3:1 -5:1 0:1 -1:2 -5:.75 -5:.25 -3:1 -5:1 2:1 0:2 -5:.75 -5:.25 7:1 4:1 0:1 -1:1 -3:1 5:.75 5:.25 4:1 0:1 2:1 0:2'],
  ['Amazing Grace', 'major', '-5:1 0:2 4:.5 0:.5 4:2 2:1 0:2 -3:1 -5:2 -5:1 0:2 4:.5 0:.5 4:2 2:1 7:3'],
  ['Mary Had a Little Lamb', 'major', '4:1 2:1 0:1 2:1 4:1 4:1 4:2 2:1 2:1 2:2 4:1 7:1 7:2 4:1 2:1 0:1 2:1 4:1 4:1 4:1 4:1 2:1 2:1 4:1 2:1 0:4'],
  ['Row Your Boat', 'major', '0:1.5 0:1.5 0:1 2:.5 4:1.5 4:1 2:.5 4:1 5:.5 7:3 12:.5 12:.5 12:.5 7:.5 7:.5 7:.5 4:.5 4:.5 4:.5 0:.5 0:.5 0:.5 7:1 5:.5 4:1 2:.5 0:3'],
  ['Jingle Bells (chorus)', 'major', '4:1 4:1 4:2 4:1 4:1 4:2 4:1 7:1 0:1.5 2:.5 4:4 5:1 5:1 5:1.5 5:.5 5:1 4:1 4:1 4:.5 4:.5 4:1 2:1 2:1 4:1 2:2 7:2'],
  ['When the Saints', 'major', '0:1 4:1 5:1 7:4 r:1 0:1 4:1 5:1 7:4 r:1 0:1 4:1 5:1 7:2 4:2 0:2 4:2 2:4'],
  ['Silent Night', 'major', '7:1.5 9:.5 7:1 4:3 7:1.5 9:.5 7:1 4:3 14:2 14:1 11:3 12:2 12:1 7:3'],
  ['Auld Lang Syne', 'major', '-5:1 0:1.5 0:.5 0:1 4:1 2:1.5 0:.5 2:1 4:1 0:1.5 0:.5 4:1 7:1 9:3 9:1 7:1.5 4:.5 4:1 0:1 2:1.5 0:.5 2:1 4:1 0:1.5 -3:.5 -3:1 -5:1 0:3'],
  ['Yankee Doodle', 'major', '0:1 0:1 2:1 4:1 0:1 4:1 2:1 -5:1 0:1 0:1 2:1 4:1 0:2 -1:2 0:1 0:1 2:1 4:1 5:1 4:1 2:1 0:1 -1:1 -5:1 -3:1 -1:1 0:2 0:2'],
  ['Greensleeves', 'minor', '0:1 3:2 5:1 7:1.5 8:.5 7:1 5:2 2:1 -2:1.5 0:.5 2:1 3:2 0:1 0:1.5 -1:.5 0:1 2:2 -1:1 -5:2'],
  ['Scarborough Fair', 'minor', '0:2 0:1 7:1 7:1 7:1 2:1.5 3:.5 2:1 0:3 r:1 7:1 10:1 12:2 10:1 7:1 9:1 5:1 7:3'],
  ['House of the Rising Sun', 'minor', '0:1 0:2 2:1 3:2 7:1 5:2 0:1 0:5 12:1 12:1 12:1 10:2 7:1 7:5'],
  ['God Rest Ye Merry', 'minor', '0:1 0:1 7:1 7:1 5:1 3:1 2:1 0:1 -2:1 0:1 2:1 3:1 5:1 7:2 0:1 0:1 7:1 7:1 5:1 3:1 2:1 0:1 -2:1 0:1 2:1 3:1 5:1 7:2'],
  ['Hava Nagila', 'minor', '7:1.5 7:.5 11:1 8:1 7:1 11:1.5 11:.5 12:1 11:1 8:1 8:1.5 8:.5 11:1 8:1 7:1 7:1.5 7:.5 11:1 8:1 7:1'],
  ['Wayfaring Stranger', 'minor', '0:1 3:1 7:2 7:1 10:1 7:2 5:1 3:1 0:3 0:1 3:1 7:2 7:1 10:1 7:2 5:1 3:1 0:3'],
  ['Erie Canal', 'minor', '7:1 7:1 3:1 0:1 0:1 3:1 5:1 7:2 7:1 8:1 7:1 5:1 3:1 2:1 0:3'],
  ['Joshua Fit the Battle', 'minor', '0:.5 -1:.5 0:.5 2:.5 3:1 3:1 5:.5 3:.5 5:.5 7:1.5 7:1 7:1 5:.5 3:.5 5:1 2:1 3:.5 2:.5 0:2'],
]
const verbose = process.argv.includes('--verbose')
let right = 0
let total = 0
const misses: Record<string, number> = {}
for (const [name, mode, text] of TUNES) {
  let tuneRight = 0
  for (let tonic = 0; tonic < 12; tonic++) {
    let beat = 0
    const notes: RawNote[] = []
    for (const token of text.split(/\s+/)) {
      const [pitch, length] = token.split(':')
      if (pitch !== 'r') notes.push({ id: `n${notes.length}`, midi: 60 + tonic + Number(pitch), startBeat: beat, durationBeats: Number(length) })
      beat += Number(length)
    }
    const { key } = analysisFromNotes(notes)
    total++
    if (key.tonic === tonic && key.mode === mode) { right++; tuneRight++ }
    else { const what = `${name} (${mode}) heard as tonic ${(key.tonic - tonic + 12) % 12 > 6 ? (key.tonic - tonic + 12) % 12 - 12 : (key.tonic - tonic + 12) % 12} ${key.mode}`; misses[what] = (misses[what] ?? 0) + 1 }
  }
  if (verbose) console.log(`  ${name.padEnd(26)} ${tuneRight}/12`)
}
console.log(`key detection on ${TUNES.length} known melodies x 12 keys: ${right}/${total} right (${(100 * right / total).toFixed(1)}%)`)
for (const [what, count] of Object.entries(misses).sort((a, b) => b[1] - a[1])) console.log(`  miss x${count}: ${what}`)
