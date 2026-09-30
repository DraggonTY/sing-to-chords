import { useEffect, useMemo, useRef, useState } from 'react'
import { Session, type PlayableNote } from './audio/session.ts'
import { applyQuantize, analyzeNoteList, layoutChords, placeLabel, type ChordSlot, type ChordSpan, type QuantizeDivision } from './music/analyze.ts'
import { transcribeSinging } from './music/transcribe.ts'
import { sampleTune, sampleWords } from './music/demo.ts'
import { chordEvents, encodePianoMidi } from './music/midi.ts'
import { PITCH_NAMES, confidenceLabel, keyName, noteName, type KeySignature, type Mode } from './music/theory.ts'

type Phase = 'ready' | 'count' | 'record' | 'analyze'
type Song = {
  source: 'sung' | 'sample'
  key: KeySignature
  confidence: number
  edits: Record<string, string>
  raw: ReturnType<typeof analyzeNoteList>['notes']
}

export default function App() {
  const [studio] = useState(() => new Session())
  const analysisRequest = useRef<AbortController | null>(null)

  const [bpm, setBpm] = useState(92)
  const [quantize, setQuantize] = useState<QuantizeDivision>('16')
  const [span, setSpan] = useState<ChordSpan>(2)
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
    () => (song ? layoutChords(notes, song.key, song.edits, span) : []),
    [song, notes, span],
  )
  const selected = slots.find((slot) => slot.id === selectedId) ?? slots[0] ?? null

  useEffect(() => {
    return () => studio.cancel()
  }, [studio])

  useEffect(() => () => analysisRequest.current?.abort(), [])

  async function startRecording() {
    setError(null)
    setPlayhead(null)
    studio?.stopPlayback()
    setPhase('count')
    setCountBeat(4)
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
      })
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
      setError('That stopped during the count-in. Let the metronome reach 1, then sing.')
      return
    }
    const request = new AbortController()
    analysisRequest.current?.abort()
    analysisRequest.current = request
    void transcribeSinging(take.samples, take.sampleRate, bpm, request.signal)
      .then((analysis) => {
        if (request.signal.aborted) return
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

  function cancelAnalysis() {
    analysisRequest.current?.abort()
    analysisRequest.current = null
    setPhase('ready')
  }

  function loadSample() {
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
    })
    setSelectedId(null)
    setPhase('ready')
    setBpm(96)
  }

  async function play() {
    if (!slots.length || !studio) return
    const piano = chordEvents(slots).map((event) => ({ ...event, velocity: 96 }))
    const melody: PlayableNote[] = hearMelody
      ? notes.map((note) => ({
          midi: note.midi,
          startBeat: note.startBeat,
          durationBeats: note.durationBeats,
          velocity: 72,
        }))
      : []
    setPianoMessage('Loading the piano…')
    setError(null)
    try {
      await studio.play([...piano, ...melody], bpm, clickOnPlay, setPlayhead)
      setPianoMessage(null)
    } catch {
      setPianoMessage(null)
      setError('The piano samples did not load. Check your connection and press play again.')
    }
  }

  function exportMidi() {
    if (!slots.length) return
    const bytes = encodePianoMidi(chordEvents(slots), bpm)
    const copy = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(copy).set(bytes)
    const blob = new Blob([copy], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'sing-to-chords-piano.mid'
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
          Sing a melody against the click. The page keeps the notes and writes a piano progression that supports them. Swap any chord, then export MIDI.
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
          <button type="button" disabled={!slots.length || busy} onClick={() => studio.stopPlayback()}>
            Stop play
          </button>
          <button type="button" disabled={!slots.length || busy} onClick={exportMidi}>
            Export MIDI
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={loadSample}>
            Load sample tune
          </button>
        </div>
      </section>

      <div className="options">
        <label>
          <input type="checkbox" checked={hearMelody} onChange={(event) => setHearMelody(event.target.checked)} />
          Hear the melody with the piano
        </label>
        <label>
          <input type="checkbox" checked={clickOnPlay} onChange={(event) => setClickOnPlay(event.target.checked)} />
          Metronome on playback
        </label>
        <p>Wear headphones so the click stays out of the recording.</p>
      </div>

      <section className={`meter phase-${phase}`} aria-live="polite">
        <Lamp pulse={pulse} active={phase === 'count' || phase === 'record'} />
        <div>
          {phase === 'count' && <strong>Count-in {countBeat}</strong>}
          {phase === 'record' && <strong>Recording · beat {countBeat}</strong>}
          {phase === 'analyze' && <strong>Transcribing the melody…</strong>}
          {phase === 'ready' && song && (
            <strong>
              {song.source === 'sample' ? 'Sample tune' : 'Recorded melody'} · {notes.length} notes
            </strong>
          )}
          {phase === 'ready' && !song && <strong>Ready when you are</strong>}
          <span>
            {phase === 'ready' && !song
              ? 'Four clicks, then sing the whole tune. Every note you hold is kept.'
              : 'Chords follow the whole phrase. Beat, half bar, or bar sets how often they can change.'}
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
