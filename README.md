# Sing to Chords

Record a melody against a metronome. The app detects a likely key, writes acoustic-piano chords under the melody, and exports that piano part as MIDI.

Requires Node.js 22.18 or newer.

```bash
npm ci
npm run dev
```

Use headphones so the click does not leak into the microphone. Quantize can snap the melody to eighths or sixteenths; notes too close to share a grid point keep their original onset order. Beat, Half, and Bar set the chord-change interval. You can change the key or choose another chord; an edited chord stays fixed while the surrounding progression is recalculated. Export MIDI writes the piano chords only.

If a recording has extra or missing notes, compare the original voice player with **Play detected melody**. The isolated melody uses the original recording timing, without chords or a click. **Save voice** downloads a WAV so the same take can be used to reproduce a transcription problem. The latest take stays available even if analysis fails or is cancelled; it is kept in browser memory and is never uploaded.

## Engine

- **One singing transcriber:** the live recording and synchronous analysis APIs use the same monophonic pitch tracker. It tracks multiple periodicity candidates over time, handles vibrato and octave ambiguity, and preserves genuine octave jumps, chromatic notes and rests. Browser analysis runs in a Web Worker, with a local fallback when workers are unavailable.
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

## Research behind the changes

- [Mauch & Dixon: pYIN (2014)](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf): retaining pitch candidates and decoding them across time. The tracker borrows this approach; it is not a full reproduction of pYIN.
- [Simon, Morris & Basu: MySong (2008)](https://www.microsoft.com/en-us/research/publication/mysong-automatic-accompaniment-generation-for-vocal-melodies/): selecting an accompaniment as a sequence. Our chord transitions are explicit musical heuristics, not MySong's trained HMM.
- [music21 key-analysis documentation](https://www.music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html): duration-weighted Krumhansl–Schmuckler key profiles and alternate interpretations.
- [Bittner et al.: vocadito (2021)](https://arxiv.org/abs/2110.05580): human note annotations for real solo vocals, including the distinction between tracking sung pitch and recognizing separate notes.
