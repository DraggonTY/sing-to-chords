# Sing to Chords

Record a melody against a metronome. The app detects a likely key, writes acoustic-piano chords under the melody, and exports that piano part as MIDI.

Requires Node.js 22.18 or newer.

```bash
npm ci
npm run dev
```

Use headphones so the click does not leak into the microphone. Quantize can snap the melody to eighths or sixteenths; notes too close to share a grid point keep their original onset order. Beat, Half, and Bar set the chord-change interval. You can change the key or choose another chord; an edited chord stays fixed while the surrounding progression is recalculated. Export MIDI writes the piano chords only.

## Engine

- **One singing transcriber:** the live recording and synchronous analysis APIs use the same monophonic pitch tracker. It tracks multiple periodicity candidates over time, handles vibrato and octave ambiguity, and preserves genuine octave jumps, chromatic notes and rests. Browser analysis runs in a Web Worker, with a local fallback when workers are unavailable.
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

The deterministic regression suite covers harmonic/vibrato audio, pitch and rest boundaries, the public transcription API, all 24 tonic-arpeggio key fixtures, sparse-key confidence, quantization collisions, sustained-note harmony, manual chord constraints, piano voices, decoded MIDI note lifetimes, and recording/playback cancellation. Synthetic checks and mocked audio-session tests do not replace evaluation with real singers.

## Research behind the changes

- [Mauch & Dixon: pYIN (2014)](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf): retaining pitch candidates and decoding them across time. The tracker borrows this approach; it is not a full reproduction of pYIN.
- [Simon, Morris & Basu: MySong (2008)](https://www.microsoft.com/en-us/research/publication/mysong-automatic-accompaniment-generation-for-vocal-melodies/): selecting an accompaniment as a sequence. Our chord transitions are explicit musical heuristics, not MySong's trained HMM.
- [music21 key-analysis documentation](https://www.music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html): duration-weighted Krumhansl–Schmuckler key profiles and alternate interpretations.
