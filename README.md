# Sing to Chords

Sing a melody freely, open a recording (WAV, MP3, M4A), or record against a metronome. The app finds the tempo and beat when there is no click, detects a likely key, writes acoustic-piano chords under the melody, and exports that piano part as MIDI.

Requires Node.js 22.18 or newer.

```bash
npm ci
npm run dev
```

Use headphones so the click does not leak into the microphone. Quantize can snap the melody to eighths or sixteenths; notes too close to share a grid point keep their original onset order. Beat, Half, and Bar set the chord-change interval. You can change the key or choose another chord; an edited chord stays fixed while the surrounding progression is recalculated. Piano sets how the chords are played: Block (held chords), Bass + chord (left-hand root, right-hand chords on the following beats), Broken (a rolling low–high–middle–high figure) or Arpeggio (a rising and falling climb that rings). Richer chords lets the harmonizer use seventh chords where the added note does not rub against the melody. Export MIDI writes the piano part in the chosen style; tick Include the melody to add the sung line as a second track on its own channel.

If a recording has extra or missing notes, compare the original voice player with **Play detected melody**. The isolated melody uses the original recording timing, without chords or a click. **Save voice** downloads a WAV so the same take can be used to reproduce a transcription problem. The latest take stays available even if analysis fails or is cancelled; it is kept in browser memory and is never uploaded.

## Engine

- **One singing transcriber:** the live recording and synchronous analysis APIs use the same monophonic pitch tracker. It tracks multiple periodicity candidates over time, handles vibrato and octave ambiguity, and preserves genuine octave jumps, chromatic notes and rests. Browser analysis runs in a Web Worker, with a local fallback when workers are unavailable.
- **Singer's tuning:** each phrase is decoded on a semitone grid shifted to where that singer's steady notes actually sit, so a voice that has drifted from A440 does not flip between neighbouring keys.
- **Vocal note boundaries:** a sequence decoder separates stable notes from vibrato and pitch slides, preserves brief chromatic notes, and uses energy dips to recover repeated notes at the same pitch. Brief missing pitch estimates do not automatically split a held note. Repetitions without a clear articulation and very slow slides remain difficult.
- **Key estimation:** duration-weighted major/minor pitch profiles, scale fit and small phrase-endpoint cues replace the old nearest-scale tie breaker. Confidence depends on competing keys and the amount of pitch-class evidence. A single held note cannot establish a key.
- **Phrase harmony:** dynamic programming chooses a complete chord sequence using melody agreement and modest transition preferences. Held notes contribute to every chord window they overlap. Empty windows remain silent, the final chord ends with the melody, and manual choices are hard constraints.
- **Piano voicing:** inversions and octave placements minimize actual voice movement within a comfortable register. Playback preserves note lengths and follows the audio clock.

Analysis is local and needs no downloaded model or server. Acoustic piano samples may require a connection; synthesized playback is available as a fallback.

This engine targets one unaccompanied singer and tonal major/minor melodies. Its harmony weights and confidence are heuristics, not a trained model or calibrated probabilities. Ambiguous melodies can have several good harmonizations. Microphone timing still depends on the browser/device capture latency, and very breathy, noisy or overlapping voices remain challenging.

## Verification

```bash
npm test
npm run build
npm run lint
```

The deterministic regression suite covers harmonic/vibrato audio, scoops and slides, quick chromatic notes, repeated-note articulations, pitch and rest boundaries, the public transcription API, all 24 tonic-arpeggio key fixtures, sparse-key confidence, quantization collisions, sustained-note harmony, manual chord constraints, piano voices, decoded MIDI note lifetimes, recording/playback cancellation, original-tempo melody audition, and WAV export. Synthetic checks and mocked audio-session tests do not replace evaluation with real singers.

### Real singing benchmark

Download and extract [vocadito v3](https://zenodo.org/records/5578807) separately (58.5 MB, CC BY 4.0). The audio is not bundled with the app. Run:

```bash
mkdir -p work
npm run benchmark:vocadito -- --dataset /path/to/vocadito --split dev --output work/vocadito-dev.json
```

The directory must contain `Audio/`, `Annotations/`, and `vocadito_metadata.csv`. The benchmark fixes the development/holdout partition by singer, evaluates both human annotators independently, and uses maximum-cardinality note matching with 50 ms onset and 50 cent pitch tolerances. It reports precision, recall, F1, unmatched events, onset-only scores, and scores that also require matching offsets. These are transcription metrics, not a percentage of recordings that will sound right to every listener.

Use `--engine /path/to/frozen-pitch.ts` to evaluate a baseline exporting `extractSingingNotes`. Reserve `--split holdout` for a frozen candidate. Note interpretations differ between the two annotators, especially for ornaments and repeated syllables; both results matter.

The September 2026 segmentation revision was developed on 22 tracks and then frozen before evaluating 18 held-out tracks from different singers. Against baseline commit `8f2058d`, the held-out results were:

| Held-out metric (macro average across tracks) | Baseline | Revised |
| --- | ---: | ---: |
| Annotator 1 note precision | 71.24% | 69.67% |
| Annotator 1 note recall | 64.75% | 66.94% |
| Annotator 1 note F1 | 67.40% | 67.97% |
| Annotator 2 note precision | 60.21% | 61.84% |
| Annotator 2 note recall | 63.44% | 68.40% |
| Annotator 2 note F1 | 61.48% | 64.65% |
| Annotator 1 note F1 with offsets | 53.43% | 55.70% |
| Annotator 2 note F1 with offsets | 46.95% | 49.70% |

Against annotator 2, unmatched estimates decreased from 370 to 364 and unmatched reference notes from 327 to 284 (842 reference notes). An unmatched event can reflect a timing or pitch error as well as an extra or missing note. Note F1 improved on 11 tracks and decreased on 7. These are modest aggregate gains; the engine still makes errors and these recordings do not validate an individual user's microphone or singing style. The frozen revised source fingerprint is `67bc590fee4853314a486269765fab71e6235145b803fdffa8a53e01e53f4a5a` (the benchmark includes imported local sources).

### November 2026 tuning revision

Unaccompanied singers drift away from A440, and a note held between two piano keys used to flip between its neighbours and be reported as several notes. The segmenter now measures each phrase's offset from the semitone grid (a circular mean of the vibrato-averaged pitch) and decodes notes on the singer's own grid. Notes shorter than 90 ms are no longer emitted, note changes cost slightly more, and same-pitch re-attacks need a slightly shallower energy dip. Each note also carries `sungPitch`, the measured pitch in fractional MIDI.

The benchmark accepts `--pitch key` (default: the semitone the app displays, as before) or `--pitch sung` (the measured pitch; an engine without `sungPitch` falls back to its semitone). Settings were chosen on the 22 development tracks and frozen before one evaluation of the 18 held-out tracks. Against the September engine (`d7a93b3`):

| Held-out metric (macro average across tracks) | September | November |
| --- | ---: | ---: |
| Annotator 1 note precision / recall (displayed semitone) | 69.7% / 66.9% | 74.2% / 64.8% |
| Annotator 1 note F1 (displayed semitone) | 67.97% | 68.96% |
| Annotator 2 note precision / recall (displayed semitone) | 61.8% / 68.4% | 65.3% / 65.6% |
| Annotator 2 note F1 (displayed semitone) | 64.65% | 65.20% |
| Annotator 1 onset-only F1 | 78.29% | 79.52% |
| Annotator 2 onset-only F1 | 74.69% | 76.83% |
| Annotator 1 note F1 with offsets | 55.70% | 56.68% |
| Annotator 2 note F1 with offsets | 49.70% | 51.89% |
| Annotator 1 note F1 (measured pitch) | 70.22%* | 73.28% |
| Annotator 2 note F1 (measured pitch) | 66.79%* | 70.70% |

\* The September engine did not report a measured pitch; these figures come from an instrumented copy that reports the median pitch of each of its notes.

The gain on the displayed semitone is small: about one point of F1, from fewer extra notes at the cost of more missed ones. Against annotator 2, unmatched estimates fell from 364 to 301 and unmatched reference notes rose from 284 to 313 (842 reference notes); note F1 improved on 12 tracks and fell on 6 (9 and 9 against annotator 1). Much of the remaining disagreement is rounding: a note sung 40–60 cents from a key has no single correct semitone, and the two annotators themselves differ by more than 50 cents on roughly one shared onset in six. Repeated notes joined by a voiced consonant and slow slides are still the main errors. The frozen source fingerprint is `bd37dd6343fc6a417a6711936c8dec8c59aeb988086367bde9df8d942a03d18d`.

A later addition drops brief notes far outside the singer's range when nothing around them is nearby (octave slips, breaths, or another instrument leaking into the recording). It was added after the held-out evaluation above, so its held-out figures are not a clean test: note F1 on the displayed semitone moved from 68.96% to 69.40% (annotator 1) and from 65.20% to 65.65% (annotator 2).

### Automatic correction and the simulated-singer benchmark

Three corrections run after transcription, with no manual editing:

- **Singer's tuning:** notes are named relative to where this singer's notes sit (following drift during the take), so a tune sung 40 cents sharp is not scattered across two keys.
- **Key:** a note sung nearly halfway between two keys takes the one that is in the detected key. A chromatic note sung squarely in tune is kept, and nothing changes unless the tune already fits the key.
- **Lateness:** with Quantize on, the take's shared lag behind the click (microphone delay, consonants before the pitch) is measured against the metre and removed before snapping, up to about a third of a beat. Off-beat rhythms are not moved.

vocadito cannot measure these, because its references are sung pitch, not the intended tune. `npm run benchmark:singer` sings eight known tunes with a seeded, imperfect simulated singer (off-A440 tuning, drift, per-note pitch error, scoops, vibrato, late and uneven entries, consonant gaps, legato slides, noise) through the app's whole pipeline and counts a note when the right key lands on the right grid step. A take sung nearly a quarter-tone off may be scored a semitone up or down as a whole.

| Simulated singer, 64 takes, 1,032 notes | Before | After |
| --- | ---: | ---: |
| Notes right, Quantize 16ths | 41.3% | 86.6% |
| Notes right, Quantize 8ths | 71.9% | 94.3% |

These are results on a model of a singer, not on people. They show the corrections work as designed; they do not establish the accuracy for a real voice and microphone. Most remaining misses are entries that land one grid step late.

### Singing without a click

With **Sing freely** on (the default), recording starts at once with no count-in or click, and **Open audio file** loads an existing recording. The tempo and beat are then found from the singing (`src/music/tempo.ts`):

1. Every tempo from 56 to 176 BPM is lined up on the opening seconds and then followed through the take, letting nearby entries pull the pulse, because nobody keeps strict time without a click. A tempo is judged by how well it stays with the singer, with a preference for a walking pace and a penalty for grids whose beats mostly pass with no entry (a melody fits a grid twice as fast equally well).
2. The bar line is the first note, unless a short pickup leads into a long note.
3. Notes are re-expressed in beats on the followed pulse, so drifting tempo is absorbed before quantizing.

Turn **Sing freely** off to record against the metronome as before.

`npm run benchmark:singer -- --free` hides the click and tempo from the simulated singer; `--drift` also lets its tempo wander by up to 10%. A take is scored after the best whole-beat shift, and the bar line is scored separately on the four tunes in 4/4 (the app lays out bars of four beats; tunes in 3/4 get a usable beat but not true bars).

| Simulated singer, 64 takes, 1,032 notes, Quantize 16ths | Tempo found | Bar line right (4/4 tunes) | Notes right |
| --- | ---: | ---: | ---: |
| With the click | given | given | 86.6% |
| No click, steady tempo | 64/64 | 29/32 | 90.9% |
| No click, drifting tempo | 64/64 | 32/32 | 92.5% |

Free singing scores higher than the click because following the singer removes lateness and unevenness note by note. These are simulated results; the tempo preference and bar-line rule were chosen with these tunes in view. On real audio: a plain sung phrase gave a confident beat with entries on beats and half beats, while a syncopated vocal stem from a produced song gave a low-confidence tempo that disagreed with its drum track (about 3:2). The app says when it is unsure of the beat.

Spotify's Basic Pitch model was also evaluated as a replacement note detector and rejected: on the 22 vocadito development tracks its best settings reached 58.4% / 55.5% note F1 (annotators 1 / 2) against 65.9% / 62.5% for this engine.

## Research behind the changes

- [Mauch & Dixon: pYIN (2014)](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf): retaining pitch candidates and decoding them across time. The tracker borrows this approach; it is not a full reproduction of pYIN.
- [Simon, Morris & Basu: MySong (2008)](https://www.microsoft.com/en-us/research/publication/mysong-automatic-accompaniment-generation-for-vocal-melodies/): selecting an accompaniment as a sequence. Our chord transitions are explicit musical heuristics, not MySong's trained HMM.
- [music21 key-analysis documentation](https://www.music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html): duration-weighted Krumhansl–Schmuckler key profiles and alternate interpretations.
- [Bittner et al.: vocadito (2021)](https://arxiv.org/abs/2110.05580): human note annotations for real solo vocals, including the distinction between tracking sung pitch and recognizing separate notes.
