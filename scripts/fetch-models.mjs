/**
 * Download the GAME singing-transcription model (openvpi, MIT licence) into
 * public/models/game. About 51 MB; fetched once and not committed.
 *
 *   node scripts/fetch-models.mjs            download if missing
 *   node scripts/fetch-models.mjs --force    download again
 *   node scripts/fetch-models.mjs --large    GAME's larger model (196 MB), into public/models/game-large;
 *                                            the app uses it when present (also: npm run models:large)
 *
 * Each file is checked against a pinned SHA-256 before it is used.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODELS = {
  standard: {
    name: 'small',
    megabytes: 51,
    target: 'game',
    files: {
      'bd2dur.onnx': '6672d56b00f27a20e9bfaa92801c15e394bb520e49031d3ed2515b0a6cf27402',
      'config.json': '60dfe7e7b57db29475604eeea9b2abf5f8cd2a49326f1f4bc0e1c14ed151a55e',
      'dur2bd.onnx': '49d10d1ea186e43c51fd2c51cedb01a3852d363f1c7056ae77df50f7e8dd0996',
      'encoder.onnx': 'a6868a702d9c88ccc06b19e54f49d88b7f8cba4a68517f20806bd81ef6f94e06',
      'estimator.onnx': 'a84738b2504472a1f22773cc6b0eccad1353a8f36229ad490b8fea85388bb5e1',
      'segmenter.onnx': '7724db4ba59a388fff5aba2f08f0ac025d4ca59caef80e7f474053a1455c88e5',
    },
  },
  large: {
    name: 'medium',
    megabytes: 196,
    target: 'game-large',
    files: {
      'bd2dur.onnx': '6672d56b00f27a20e9bfaa92801c15e394bb520e49031d3ed2515b0a6cf27402',
      'config.json': '4d62b6d058a820e981184ea6f04605d37659c4331ee01979eb14a14be08af890',
      'dur2bd.onnx': '49d10d1ea186e43c51fd2c51cedb01a3852d363f1c7056ae77df50f7e8dd0996',
      'encoder.onnx': 'fb00295abf8156806a3bf2477ccadc9dd6a8f464fa4ee1a65c85100ce17e36fe',
      'estimator.onnx': '2662a01e24548dc3b9f8ebc081b26947873c01eeaa573c9d0a87e7bf2a43642b',
      'segmenter.onnx': '49c20f890d02f8877be4b092fae3913ec969e9236cf0a91e661e8bf52465ffda',
    },
  },
}
const chosen = MODELS[process.argv.includes('--large') ? 'large' : 'standard']
const RELEASE = `https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-${chosen.name}-onnx.zip`
const FOLDER = `GAME-1.0.3-${chosen.name}-onnx`
const FILES = chosen.files
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/models', chosen.target)
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const complete = () => Object.entries(FILES).every(([name, hash]) => existsSync(path.join(target, name)) && sha(path.join(target, name)) === hash)

if (!process.argv.includes('--force') && complete()) {
  console.log(`GAME model (${chosen.name}) already installed.`)
  process.exit(0)
}
const work = mkdtempSync(path.join(tmpdir(), 'game-model-'))
try {
  console.log(`Downloading the GAME singing model (${chosen.name}, about ${chosen.megabytes} MB)…`)
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', path.join(work, 'model.zip'), RELEASE], { stdio: ['ignore', 'ignore', 'inherit'] })
  execFileSync('unzip', ['-q', '-o', path.join(work, 'model.zip'), '-d', work])
  for (const [name, hash] of Object.entries(FILES)) {
    const actual = sha(path.join(work, FOLDER, name))
    if (actual !== hash) throw new Error(`${name} does not match its expected checksum; nothing was installed.`)
  }
  mkdirSync(target, { recursive: true })
  for (const name of Object.keys(FILES)) renameSync(path.join(work, FOLDER, name), path.join(target, name))
  writeFileSync(path.join(target, 'SOURCE.txt'), `GAME 1.0.3 (${chosen.name}), ONNX export. MIT licence.\nhttps://github.com/openvpi/GAME\n${RELEASE}\n`)
  console.log(`Installed in ${path.relative(process.cwd(), target)}.`)
} catch (error) {
  // The app still works without it, with the built-in engine.
  console.error(`Could not install the GAME model: ${error.message}`)
  process.exitCode = process.argv.includes('--optional') ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
