import { useEffect, useMemo, useRef, useState } from 'react'
import { Session, type RecordedTake } from './audio/session.ts'
import { makePlaybackPlan } from './audio/playback.ts'
import { encodeMonoWav } from './audio/wav.ts'
import { applyQuantize, analyzeNoteList, layoutChords, placeLabel, type ChordSlot, type ChordSpan, type QuantizeDivision } from './music/analyze.ts'
import { transcribeSinging } from './music/transcribe.ts'
import { sampleTune, sampleWords } from './music/demo.ts'
import { PIANO_STYLES, pianoEvents, type PianoStyle } from './music/accompany.ts'
import { encodePianoMidi } from './music/midi.ts'
import { PITCH_NAMES, confidenceLabel, keyName, noteName, type KeySignature, type Mode } from './music/theory.ts'
import './RecordingReview.css'

type Phase = 'ready' | 'count' | 'record' | 'analyze'
type Song = {
  source: 'sung' | 'sample'
  key: KeySignature
  confidence: number
  edits: Record<string, string>
  raw: ReturnType<typeof analyzeNoteList>['notes']
  recordedBpm: number
  takeId?: number
  engine?: 'neural' | 'built-in'
}
type SavedTake = RecordedTake & { id: number; bpm: number; url: string; free: boolean }

export default function App() {
  const [studio] = useState(() => new Session())
  const analysisRequest = useRef<AbortController | null>(null)
  const playbackRequest = useRef(0)
  const takeSequence = useRef(0)
  const originalVoice = useRef<HTMLAudioElement | null>(null)
  const [lastTake, setLastTake] = useState<SavedTake | null>(null)

  const [bpm, setBpm] = useState(92)
  const [quantize, setQuantize] = useState<QuantizeDivision>('16')
  const [span, setSpan] = useState<ChordSpan>(2)
  const [style, setStyle] = useState<PianoStyle>('block')
  const [rich, setRich] = useState(false)
  const [melodyInMidi, setMelodyInMidi] = useState(false)
  const [freeTempo, setFreeTempo] = useState(true)
  const [beatNote, setBeatNote] = useState<string | null>(null)
  const filePicker = useRef<HTMLInputElement | null>(null)
  const [pianoMessage, setPianoMessage] = useState<string | null>(null)
  const [hearMelody, setHearMelody] = useState(true)
  const [clickOnPlay, setClickOnPlay] = useState(true)
  const [phase, setPhase] = useState<Phase>('ready')
  const [countBeat, setCountBeat] = useState(0)
  const [pulse, setPulse] = useState(0)
  const [song, setSong] = useState<Song | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const notes = useMemo(() => (song ? applyQuantize(song.raw, quantize) : []), [song, quantize])
  const slots = useMemo(
    () => (song ? layoutChords(notes, song.key, song.edits, span, rich) : []),
    [song, notes, span, rich],
  )
  const selected = slots.find((slot) => slot.id === selectedId) ?? slots[0] ?? null

  useEffect(() => {
    return () => {
      playbackRequest.current += 1
      studio.cancel()
    }
  }, [studio])

  useEffect(() => () => analysisRequest.current?.abort(), [])

  useEffect(() => {
    const player = originalVoice.current
    return () => {
      player?.pause()
      if (lastTake) URL.revokeObjectURL(lastTake.url)
    }
  }, [lastTake])

  function stopPiano() {
    playbackRequest.current += 1
    studio.stopPlayback()
    setPianoMessage(null)
    setPlayhead(null)
  }

  async function startRecording() {
    originalVoice.current?.pause()
    analysisRequest.current?.abort()
    analysisRequest.current = null
    setError(null)
    setPlayhead(null)
    stopPiano()
    setPhase(freeTempo ? 'record' : 'count')
    setCountBeat(freeTempo ? 1 : 4)
    try {
      await studio?.arm(bpm, (beat, nextPhase) => {
        setPulse(beat)
        if (nextPhase === 'count') {
          setPhase('count')
          setCountBeat(4 - beat)
        } else {
          setPhase('record')
          setCountBeat(beat + 1)
        }
      }, freeTempo)
    } catch {
      setPhase('ready')
      setError('Microphone access is blocked. Allow the mic in the browser, then record again.')
    }
  }

  function stopRecording() {
    setPhase('analyze')
    const take = studio?.finishTake()
    if (!take) {
      setPhase('ready')
      setError(freeTempo ? 'That take was too short. Press Record and sing a full phrase.' : 'That stopped during the count-in. Let the metronome reach 1, then sing.')
      return
    }
    analyzeTake(take, freeTempo)
  }

  /** Transcribe a take. `free` means it was not sung to the click: find its beat. */
  function analyzeTake(take: RecordedTake, free: boolean) {
    setPhase('analyze')
    setBeatNote(null)
    const savedTake: SavedTake = {
      ...take,
      id: ++takeSequence.current,
      bpm,
      free,
      url: URL.createObjectURL(new Blob([encodeMonoWav(take.samples, take.sampleRate)], { type: 'audio/wav' })),
    }
    setLastTake(savedTake)
    const request = new AbortController()
    analysisRequest.current?.abort()
    analysisRequest.current = request
    void transcribeSinging(savedTake.samples, savedTake.sampleRate, free ? null : savedTake.bpm, request.signal)
      .then((analysis) => {
        if (request.signal.aborted) return
        if (analysis.engineError) console.warn('Neural pitch engine unavailable, using the built-in one:', analysis.engineError)
        const found = free && analysis.bpm ? analysis.bpm : savedTake.bpm
        if (free && analysis.notes.length) {
          setLastTake((current) => (current?.id === savedTake.id ? { ...current, bpm: found } : current))
          setBpm(Math.min(160, Math.max(60, Math.round(found))))
          setBeatNote((analysis.beatConfidence ?? 0) >= 0.3
            ? `Found your tempo: about ${Math.round(found)} BPM.`
            : `Not sure of your beat (guessed ${Math.round(found)} BPM). A steadier take, or singing with the click, will place the chords better.`)
        }
        if (!analysis.notes.length) {
          setPhase('ready')
          setError('No clear melody came through. Use headphones, sing a little closer, and hold each note.')
          return
        }
        setSong({
          source: 'sung',
          key: analysis.key,
          confidence: analysis.confidence,
          edits: {},
          raw: analysis.notes,
          recordedBpm: found,
          takeId: savedTake.id,
          engine: analysis.engine,
        })
        setSelectedId(null)
        setPhase('ready')
      })
      .catch(() => {
        if (request.signal.aborted) return
        setPhase('ready')
        setError('The melody could not be analyzed. Try recording a shorter, clearer phrase.')
      })
      .finally(() => {
        if (analysisRequest.current === request) analysisRequest.current = null
      })
  }

  async function openFile(file: File | undefined) {
    if (!file) return
    originalVoice.current?.pause()
    analysisRequest.current?.abort()
    analysisRequest.current = null
    stopPiano()
    studio.cancel()
    setError(null)
    setPhase('analyze')
    try {
      const take = await studio.decodeFile(await file.arrayBuffer())
      if (take.samples.length / take.sampleRate > 600) {
        setPhase('ready')
        setError('That recording is longer than 10 minutes. Please choose a shorter one.')
        return
      }
      analyzeTake(take, true)
    } catch {
      setPhase('ready')
      setError('That file could not be read as audio. Try a WAV, MP3 or M4A recording.')
    }
  }

  function cancelAnalysis() {
    analysisRequest.current?.abort()
    analysisRequest.current = null
    setPhase('ready')
  }

  function loadSample() {
    originalVoice.current?.pause()
    analysisRequest.current?.abort()
    analysisRequest.current = null
    stopPiano()
    studio?.cancel()
    setError(null)
    setPlayhead(null)
    const analysis = analyzeNoteList(sampleTune)
    setSong({
      source: 'sample',
      key: analysis.key,
      confidence: analysis.confidence,
      edits: {},
      raw: analysis.notes,
      recordedBpm: 96,
    })
    setSelectedId(null)
    setBeatNote(null)
    setPhase('ready')
    setBpm(96)
  }

  async function play(melodyOnly = false) {
    if (!song || !(melodyOnly ? song.raw.length : slots.length)) return
    originalVoice.current?.pause()
    const request = ++playbackRequest.current
    const plan = makePlaybackPlan(song, { notes, chords: slots, bpm, hearMelody, withClick: clickOnPlay, style }, melodyOnly)
    setPianoMessage('Loading the piano…')
    setError(null)
    try {
      await studio.play(plan.notes, plan.bpm, plan.withClick, setPlayhead)
      if (request === playbackRequest.current) setPianoMessage(null)
    } catch {
      if (request !== playbackRequest.current) return
      setPianoMessage(null)
      setError('The piano samples did not load. Check your connection and press play again.')
    }
  }

  function saveVoice() {
    if (!lastTake) return
    const link = document.createElement('a')
    link.href = lastTake.url
    link.download = 'sing-to-chords-voice.wav'
    link.click()
  }

  function exportMidi() {
    if (!slots.length) return
    const bytes = encodePianoMidi(pianoEvents(slots, style), bpm, melodyInMidi ? notes : [])
    const copy = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(copy).set(bytes)
    const blob = new Blob([copy], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = melodyInMidi ? 'sing-to-chords-piano-and-melody.mid' : 'sing-to-chords-piano.mid'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  function setKey(next: KeySignature) {
    setSong((current) => (current ? { ...current, key: next, edits: {} } : current))
  }

  function chooseChord(slot: ChordSlot, chordId: string) {
    setSong((current) =>
      current ? { ...current, edits: { ...current.edits, [slot.id]: chordId } } : current,
    )
    setSelectedId(slot.id)
  }

  const busy = phase === 'count' || phase === 'record' || phase === 'analyze'
  const lastBeat = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 4)
  const rulerBeats = Math.max(4, Math.ceil(lastBeat))

  return (
    <div className="stage">
      <header className="top">
        <div>
          <p className="eyebrow">Voice to accompaniment</p>
          <h1>Sing to Chords</h1>
        </div>
        <p className="lede">
          Sing a melody at your own pace, or open a recording. The page finds your beat, keeps the notes and writes a piano progression that supports them. Swap any chord, then export MIDI.
        </p>
      </header>

      <section className="transport">
        <label className="bpm">
          <span>Tempo</span>
          <strong>{bpm}</strong>
          <input
            type="range"
            min={60}
            max={160}
            value={bpm}
            disabled={busy}
            onChange={(event) => setBpm(Number(event.target.value))}
          />
        </label>

        <div className="segmented" role="group" aria-label="Quantize">
          <span>Quantize</span>
          {(
            [
              ['off', 'Off'],
              ['8', '8ths'],
              ['16', '16ths'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={quantize === value ? 'on' : ''}
              aria-pressed={quantize === value}
              disabled={busy}
              onClick={() => setQuantize(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="segmented" role="group" aria-label="Chord rhythm">
          <span>Chords</span>
          {(
            [
              [1, 'Beat'],
              [2, 'Half'],
              [4, 'Bar'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={span === value ? 'on' : ''}
              aria-pressed={span === value}
              disabled={busy}
              onClick={() => setSpan(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="segmented" role="group" aria-label="Piano style">
          <span>Piano</span>
          {PIANO_STYLES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={style === value ? 'on' : ''}
              aria-pressed={style === value}
              disabled={busy}
              onClick={() => {
                stopPiano()
                setStyle(value)
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="buttons">
          {phase === 'record' || phase === 'count' ? (
            <button className="stop" type="button" onClick={stopRecording}>
              Stop
            </button>
          ) : phase === 'analyze' ? (
            <button type="button" onClick={cancelAnalysis}>Cancel analysis</button>
          ) : (
            <button className="record" type="button" onClick={startRecording}>
              Record
            </button>
          )}
          <button type="button" disabled={!slots.length || busy || pianoMessage !== null} onClick={() => void play()}>
            {pianoMessage ?? 'Play piano'}
          </button>
          <button type="button" disabled={!notes.length || busy || pianoMessage !== null} onClick={() => void play(true)}>
            Play detected melody
          </button>
          <button type="button" disabled={(!notes.length && !lastTake) || busy} onClick={() => {
            originalVoice.current?.pause()
            stopPiano()
          }}>
            Stop play
          </button>
          <button type="button" disabled={!slots.length || busy} onClick={exportMidi}>
            Export MIDI
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => filePicker.current?.click()}>
            Open audio file
          </button>
          <input
            ref={filePicker}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
            hidden
            onChange={(event) => {
              void openFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button type="button" className="ghost" disabled={busy} onClick={loadSample}>
            Load sample tune
          </button>
        </div>
      </section>

      <div className="options">
        <label>
          <input type="checkbox" checked={freeTempo} disabled={busy} onChange={(event) => setFreeTempo(event.target.checked)} />
          Sing freely (no click — find my beat)
        </label>
        <label>
          <input type="checkbox" checked={hearMelody} onChange={(event) => setHearMelody(event.target.checked)} />
          Hear the melody with the piano
        </label>
        <label>
          <input type="checkbox" checked={clickOnPlay} onChange={(event) => setClickOnPlay(event.target.checked)} />
          Metronome on playback
        </label>
        <label>
          <input type="checkbox" checked={rich} onChange={(event) => setRich(event.target.checked)} />
          Richer chords (7ths)
        </label>
        <label>
          <input type="checkbox" checked={melodyInMidi} onChange={(event) => setMelodyInMidi(event.target.checked)} />
          Include the melody in the MIDI file
        </label>
        <p>{freeTempo ? 'Just press Record and sing at your own pace.' : 'Wear headphones so the click stays out of the recording.'}</p>
      </div>

      {lastTake && (
        <section className="options voice-review" aria-label="Compare your voice and detected melody">
          <div className="voice-review-label">
            <strong>Original voice</strong>
            <small>{(lastTake.samples.length / lastTake.sampleRate).toFixed(1)} seconds · {lastTake.free ? 'tempo found:' : 'recorded at'} {Math.round(lastTake.bpm)} BPM</small>
          </div>
          <audio
            ref={originalVoice}
            src={lastTake.url}
            controls={!busy}
            preload="metadata"
            aria-label="Original voice recording"
            onPlay={() => {
              if (busy) originalVoice.current?.pause()
              else {
                stopPiano()
                setError(null)
              }
            }}
            onError={() => setError('The voice recording could not play. Use Save voice to listen to the WAV file.')}
          />
          <button type="button" className="ghost" onClick={saveVoice}>Save voice</button>
          <p>Detected melody · original timing, without chords or the click. Tempo and Quantize apply to Play piano.</p>
          {song && song.takeId !== lastTake.id && (
            <p>The displayed melody is from {song.source === 'sample' ? 'the sample tune' : 'your previous take'}.</p>
          )}
        </section>
      )}

      <section className={`meter phase-${phase}`} aria-live="polite">
        <Lamp pulse={pulse} active={phase === 'count' || (phase === 'record' && !freeTempo)} />
        <div>
          {phase === 'count' && <strong>Count-in {countBeat}</strong>}
          {phase === 'record' && <strong>{freeTempo ? 'Recording · sing at your own pace' : `Recording · beat ${countBeat}`}</strong>}
          {phase === 'analyze' && <strong>Transcribing the melody…</strong>}
          {phase === 'ready' && song && (
            <strong>
              {song.source === 'sample' ? 'Sample tune' : 'Recorded melody'} · {notes.length} notes
              {song.engine === 'neural' ? ' · noisy recording, neural pitch engine' : ''}
            </strong>
          )}
          {phase === 'ready' && !song && <strong>Ready when you are</strong>}
          <span>
            {phase === 'ready' && !song
              ? freeTempo
                ? 'Press Record and sing the whole tune, or open a recording. The app finds your tempo and beat.'
                : 'Four clicks, then sing the whole tune. Compare your voice with the detected melody afterward.'
              : beatNote ?? 'Chords follow the whole phrase. Beat, half bar, or bar sets how often they can change.'}
          </span>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      {song && (
        <>
          <section className="keybar">
            <div>
              <p className="eyebrow">Detected key</p>
              <h2>{keyName(song.key)}</h2>
              <p>{confidenceLabel(song.confidence)}</p>
            </div>
            <label>
              Tonic
              <select
                value={song.key.tonic}
                onChange={(event) => setKey({ ...song.key, tonic: Number(event.target.value) })}
              >
                {PITCH_NAMES.map((name, tonic) => (
                  <option key={name} value={tonic}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode
              <select
                value={song.key.mode}
                onChange={(event) => setKey({ ...song.key, mode: event.target.value as Mode })}
              >
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </label>
            <button
              type="button"
              className="ghost"
              onClick={() => setSong((current) => (current ? { ...current, edits: {} } : current))}
            >
              Reset chords
            </button>
          </section>

          <section className="sheet">
            <div className="roll-wrap">
              <div className="score">
                {playhead != null && (
                  <i className="playhead" style={{ left: `${Math.min(100, (playhead / rulerBeats) * 100)}%` }} />
                )}
                <div className="ruler">
                  {Array.from({ length: rulerBeats }, (_, beat) => (
                    <span key={beat}>{beat % 4 === 0 ? beat / 4 + 1 : ''}</span>
                  ))}
                </div>
                <div className="melody">
                  {notes.map((note) => {
                    const low = Math.min(...notes.map((item) => item.midi))
                    const word = note.id.startsWith('sample-') ? sampleWords[Number(note.id.slice(7))] : null
                    return (
                      <span
                        key={note.id}
                        className="blob"
                        style={{
                          left: `${(note.startBeat / rulerBeats) * 100}%`,
                          width: `max(36px, ${(note.durationBeats / rulerBeats) * 100}% - 6px)`,
                          bottom: 8 + (note.midi - low) * 11,
                        }}
                      >
                        <b>{noteName(note.midi)}</b>
                        {word ? <small>{word}</small> : null}
                      </span>
                    )
                  })}
                </div>
                <div className="chords">
                  {slots.map((slot) => (
                    <button
                      key={slot.id}
                      type="button"
                      className={selected?.id === slot.id ? 'harmony on' : 'harmony'}
                      style={{
                        left: `${(slot.startBeat / rulerBeats) * 100}%`,
                        width: `max(36px, ${(slot.durationBeats / rulerBeats) * 100}% - 8px)`,
                      }}
                      onClick={() => setSelectedId(slot.id)}
                    >
                      <strong>{slot.chord.symbol}</strong>
                      <small>{placeLabel(slot.startBeat)}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {selected && (
              <div className="picker">
                <div>
                  <p className="eyebrow">Chord at {placeLabel(selected.startBeat)}</p>
                  <h3>{selected.chord.symbol}</h3>
                  <p>
                    Supports the melody in {keyName(song.key)}. Held notes and the surrounding chords shape the progression.
                  </p>
                </div>
                <div className="choices">
                  {selected.options.map((chord) => (
                    <button
                      key={chord.id}
                      type="button"
                      className={chord.id === selected.chord.id ? 'choice on' : 'choice'}
                      onClick={() => chooseChord(selected, chord.id)}
                    >
                      {chord.symbol}
                      {song.edits[selected.id] === chord.id ? <small> chosen</small> : null}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Lamp({ pulse, active }: { pulse: number; active: boolean }) {
  return (
    <div className={active ? 'lamp on' : 'lamp'} aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <span key={index} className={active && pulse === index ? 'lit' : ''} />
      ))}
    </div>
  )
}
