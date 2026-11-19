# Sing to Chords

Sing a melody freely, open a recording (WAV, MP3, M4A), or record against a metronome. The app finds the tempo and beat when there is no click, detects a likely key, writes acoustic-piano chords under the melody, and exports that piano part as MIDI.

Requires Node.js 22.18 or newer.

```bash
npm ci
npm run dev
```

Use headphones so the click does not leak into the microphone. Quantize can snap the melody to eighths or sixteenths; notes too close to share a grid point keep their original onset order. Beat, Half, and Bar set the chord-change interval. You can change the key or choose another chord; an edited chord stays fixed while the surrounding progression is recalculated. Piano sets how the chords are played: Block (held chords), Bass + chord (left-hand root, right-hand chords on the following beats), Broken (a rolling low–high–middle–high figure) or Arpeggio (a rising and falling climb that rings). Richer chords lets the harmonizer use seventh chords where the added note does not rub against the melody. Export MIDI writes the piano part in the chosen style; tick Include the melody to add the sung line as a second track on its own channel.

If a recording has extra or missing notes, compare the original voice player with **Play detected melody**. The isolated melody uses the original recording timing, without chords or a click. **Save voice** downloads a WAV so the same take can be used to reproduce a transcription problem. The latest take stays available even if analysis fails or is cancelled; it is kept in browser memory and is never uploaded.

## The GAME engine and the score-level test

The app now transcribes with [GAME](https://github.com/openvpi/GAME) (openvpi, MIT), a model trained to turn singing into notes, followed by a clean-up stage and the tuning, key and beat corrections described below. GAME is published in two sizes and the app installs both: `npm run models` downloads the standard one (51 MB) and `npm run models:large` the larger one (196 MB), each checksum-verified and not committed; `npm run dev` and `npm run build` fetch whichever is missing. The larger model is used by default, with clean-up weights trained for it. A **Larger singing model (slower)** switch turns it off and transcribes the current take again with the standard model, so the two can be compared on the same singing; in the browser a 34-second recording took about four seconds with the standard model and nine with the larger one. The choice of default is a trade: the larger model scored higher on the Korean test below (97.1% against 96.8%), the same or slightly lower on the English one (95.1% against 95.3%), and lower on other singers (78.7% against 80.1%). If the larger model is not installed or cannot run, the standard one is used; without either, the app falls back to the pitch-tracking engines. Everything runs in the browser on the device, on several threads when the page is cross-origin isolated (the dev and preview servers send the headers).

- **GAME** (`src/music/game.ts`): the published ONNX graphs. The encoder turns audio into features, the segmenter finds note boundaries in eight refinement passes, the estimator gives each note a pitch. Long recordings are cut at their quietest moments into pieces of at most 20 s.
- **Clean-up** (`src/music/gameTidy.ts`): GAME writes a singer's scoop into a note as a short extra note below it, and sometimes splits one held note. For every boundary between two touching notes, three small networks and a forest of boosted trees, averaged, decide whether a new note really starts there, from GAME's own features around the boundary and the two notes' lengths and pitches. `scripts/train-game-tidy.py` trains it, once for each model size.

### Measured on real singing with the true score

`scripts/benchmark-csd.ts` uses the [Children's Song Dataset](https://zenodo.org/records/4916302) (Choi et al., 2020; CC BY-NC-SA 4.0): one professional singer, 50 English songs in two keys each, with the score's notes labelled in time. A score note counts as right when a detected note has the same semitone and starts within 100 ms of it, one detection per note; the figure is F1 over all notes. Songs 1–30 were the development set; songs 31–50 (40 recordings, 5,799 notes) were held out and scored once.

| Held-out songs | Notes right (100 ms) | Precision / recall | Within 50 ms |
| --- | ---: | ---: | ---: |
| Previous engine (pitch tracking and note segmenter) | 78.7% | 78.6% / 78.9% | 73.8% |
| GAME alone | 89.8% | 87.4% / 92.4% | 85.1% |
| GAME standard model, clean-up, tuning and key correction (the app with the switch off) | 95.3% | 95.3% / 95.3% | 90.3% |
| The same with the larger model (the app's default) | **95.1%** | 94.8% / 95.4% | 90.3% |

The held-out songs were scored once with a network-only clean-up (95.0%), a second time after boosted trees were added to it (95.33%), and a third time after the correction below (95.31%, the standard model's shipped weights); the larger model was scored on them at clean-up cut-offs 0.5 and 0.4 (95.10% both times) and once with the smaller clean-up network described below. Nothing was tuned on them. On the development songs the pipeline scored 95.3% with the clean-up cross-validated by song.

**Shared tunes, found afterwards and corrected.** The dataset's two halves overlap: 25 of the English songs are also sung in Korean, and *Twinkle twinkle little star* has the tune of the *Alphabet* song. Six held-out songs (33, 39, 41, 42, 46, 48) therefore had their melody in the clean-up's training data in another language or under another title. The clean-up is now trained without those recordings (one English song and 13 Korean recordings; `SHARED_TUNES` in the training script), and the cross-validated figures keep every recording with a test song's tune out of training. The effect was small: held-out 95.33% → 95.31%, development 95.4% → 95.3%, Korean 96.95% → 96.8%. Tunes were matched by the score's pitch steps with repeated notes merged.

**A second test set: the dataset's Korean half.** 87 recordings (13,653 notes) by the same singer. They are part of the clean-up's training data, so each song was scored by a clean-up trained without it or any recording of the same tune (five folds by song; the other English and Korean recordings in training), then given the app's tuning and key correction:

| Korean songs, each held out of the clean-up's training | Notes right (100 ms) | Precision / recall |
| --- | ---: | ---: |
| All 87 recordings, GAME alone and key-aware naming | 95.4% | 95.2% / 95.6% |
| All 87 recordings, the pipeline with the standard model (the switch off) | 96.8% | 97.8% / 95.8% |
| All 87 recordings, the pipeline with the larger model (the app's default) | **97.1%** | 98.0% / 96.3% |
| Songs 11–50 only (70 recordings, 11,116 notes) | 97.3% | 98.0% / 96.6% |

With the standard model the full-set figure is 96.8%, short of 97%. With the larger model, the app's default, it is 97.1%: 97.17% and 97.24% on two runs of the model at a clean-up cut-off of 0.4, the cut-off the development data preferred and the one shipped, and 97.05–97.19% over seven runs at 0.5 (repeats of the cross-validation on both model runs; GAME's output varies slightly from run to run). The standard model's repeats gave 96.73–96.82%. The margin over 97% is thin: 0.05 points is seven notes. The songs 11–50 row needs a caveat: that split was made to choose GAME's language setting on songs 1–10 (which in the end made no difference), after it was already visible that several of the weakest recordings were among songs 1–10, so it is not a clean selection. These songs suit the method better than the English ones: only 3% of GAME's touching boundaries are false there against 10% in the English songs (fewer scoops), and an independent pitch tracker contradicts 1.8% of the labels against 3.6%.

What this does and does not show:

- **It is 95% on the English songs, not higher, and part of the rest is the labels.** The labels mark syllable boundaries drawn by hand, consonants included, which sit up to about 100 ms from where the pitch changes on the beat; about 1.2% of development notes were detected with the right pitch 100–200 ms from their label. In about 1% more, an independent pitch tracker agrees with GAME that the singer sang a different note from the one labelled. With every boundary decision perfect, this pipeline would score about 96.5% on the development songs.
- **One singer.** The clean-up was trained on this singer (English development songs plus 74 Korean recordings from the same dataset), and tested on her other songs. On vocadito (29 singers, labels of what was sung rather than of the score, 50 ms window) GAME matches annotator 2 far better than the previous engine (79.9% against 71.2% held out) and annotator 1 worse (66.9% against 73.7%), and the clean-up costs one to two points against both, because those annotators count ornaments as notes.
- **Training-data licence.** The clean-up weights were learned from CSD, which is licensed for non-commercial use. Retrain on other data before any commercial use.
- **Why not higher: three methods stop at the same place.** After the clean-up, I trained a second decoder from scratch on the labels themselves (a two-layer bidirectional GRU over GAME's encoder features, predicting note starts and score pitch), and then combined it with the clean-up. Alone it scored 93.8% on its validation songs; as extra evidence for the boundary decisions it changed nothing (97.0% of decisions right with or without it); settling halfway pitches with it lost 0.4–0.6 points; adding the note starts it found gained 0.07. A model trained on these labels cannot match their timing better than GAME does, so what remains at the boundaries is disagreement in the hand labels rather than something learnable.
- **Against labels an independent tracker does not contradict.** SwiftF0 contradicts 3.6% of the held-out labels (its median pitch over the note is 0.7 semitones or more from the label, or the voice runs on and its pitch changes more than 100 ms from the labelled boundary). Scored only against the rest, the held-out figure is 96.2%. So about one point of the gap to 100% is the labels; the other four are real mistakes: missed note starts (about 1.9%), extra notes (about 1.3%) and pitches GAME reports as exactly halfway between two keys (about 0.8%).
- **Fine-tuning GAME itself on this singer reaches the same place.** GAME's small model was trained further with its own training code on the development songs and the Korean recordings (CPU, learning rate 1e-4). Without any clean-up it scored 95.3% on the held-out songs after 600 steps, 95.7% after 1,500 and 95.7% after 3,000 (96.3–96.5% against uncontradicted labels), so it had stopped improving. On the fourteen held-out songs whose tune it had never seen it scored 95.1% against the standard pipeline's 94.2%; on the six it had seen in Korean, 96.3–96.8% against 97.2%. On vocadito's other singers it was about a point worse than the original weights (78.7% against 79.9% for annotator 2, held out). It is not in the app: the gain is specific to one singer. Voting between three of its checkpoints scored below the best single one.
- **97% was the target. The app reaches it on the Korean test, and not on the English one.** GAME's medium model (196 MB against 51 MB) was run over all 187 recordings and given its own clean-up, trained the same way (the app's default; a switch turns it off). Korean, all 87 recordings, cross-validated by song with shared tunes left out: 97.1% (above). English held-out: 95.1%, against 95.3% for the standard model (96.1% against uncontradicted labels). The two tests pooled, 127 recordings and 19,452 notes: 96.5% against 96.3%. On vocadito's other singers, held out, it scored 78.7% for annotator 2 and 65.7% for annotator 1, against the standard model's 80.1% and 67.0%. Without a clean-up the two models are level (English held-out 89.0% and 89.8%, Korean 95.4% and 95.4%). The larger model was picked for this comparison after the standard model's results on the same tests were known, so its Korean figure is the better of two tries. It is the default because the Korean test is the cleaner of the two (an independent tracker contradicts 1.8% of its labels against 3.6%) and the two tests pooled favour it slightly; the cost is a larger download, about twice the time, and the lower score on other singers, which is why the standard model stays one switch away. A smaller clean-up network for it, chosen on development data to close the gap on other singers, did not: 79.1% and 66.0% on vocadito held out, 95.0% on English held-out, 97.2% on Korean. For the standard model the best complete, clean figures are 95.3% (English held-out) and 96.8% (Korean, cross-validated); fine-tuning for this singer reached 95.7% on English held-out and is not shipped. About 3.6% of the English held-out labels are contradicted by an independent pitch tracker, which puts 97% against every label out of reach there for a system that writes down what was sung.
- Also tried without gain, all measured on development or cross-validated data: GAME's language settings on the Korean songs (Japanese finds more note starts raw, 92.5% against 91.2% on a subset, but nothing after the clean-up); pooling the note starts of two GAME passes (98.5% of starts found against 97.8%, same final score); choosing the clean-up's cut-off inside each training fold (flat between 0.2 and 0.6); splitting long notes at loudness dips (five points worse: hundreds of false notes).
- Rejected along the way: showing the clean-up both models' view of each boundary (95.3–95.4% on the development songs against 95.2–95.3% without); recording GAME's confidence with a stricter second pass (no gain once its features are used); pitch-curve, loudness, timbre and beat-grid inputs to the clean-up (0.2–0.4 points); settling in-between pitches from a pitch curve (no gain).

```bash
# Score the app's pipeline (needs the dataset, GAME's notes from src/music/game.ts run under Node, and SwiftF0 voicing)
node scripts/benchmark-csd.ts --dataset /path/to/csd --voicing /path/to/voicing --game notes.json --split holdout
```

## Engine

The engines below are the fallback when the GAME model is not installed or cannot run.


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

### Key detection

Key profiles are now Aarden–Essen (scale-degree use in sung folk melodies) instead of Krumhansl–Kessler probe-tone ratings, which describe harmony and heard a tune that dwells on its third as the minor key on that note. `npm run benchmark:key` checks 20 well-known melodies, given as exact notes, in all 12 keys: 180/240 (75%) before, 216/240 (90%) after. The two remaining tunes are modal (Dorian and Phrygian dominant), which a major/minor model cannot name. On the simulated singer without a click, the key was right in 47 of 64 takes, up from about 39.

When a voice sits a quarter-tone or so from the piano's tuning, the tune lies between two keys; it is then named in the neighbouring key with fewer sharps or flats (D minor rather than E flat minor), which also gives easier chords. A melody that uses only four or five different notes can still fit several keys equally well; the tonic and mode selectors remain for that case.

### Pitch engines, tested on real singers

Three experiments on vocadito (real solo singers, scored against the measured pitch):

1. **Where is the loss?** Feeding the dataset's hand-corrected pitch curves into this app's note segmenter scored 74.0% / 70.9% note F1 (annotators 1 / 2, 22 development tracks) against 70.3% / 66.8% for the app. A perfect pitch tracker is therefore worth about four points; the larger remaining gap is in deciding where notes begin, above all repeated notes with no pitch change.
2. **A neural pitch tracker.** [SwiftF0](https://github.com/lars76/swift-f0) (MIT, 135 KB) feeding the same segmenter:

   | Note F1, annotator 1 / 2 | Built-in tracker | SwiftF0 |
   | --- | ---: | ---: |
   | Development, clean | 70.3 / 66.8 | 73.4 / 68.7 |
   | Held out, clean | 73.7 / 71.2 | 73.2 / 71.8 |
   | Held out, noise at 20 dB | 75.2 / 72.6 | 74.3 / 71.9 |
   | Held out, noise at 10 dB | 70.1 / 70.6 | 73.9 / 72.8 |

   The two tie on clean recordings from singers not used for tuning; SwiftF0 holds its accuracy in heavy noise where the built-in tracker loses about three points. The noise is synthetic (broadband, low rumble and hum added to the recordings).
3. **Basic Pitch** as a whole-note detector was rejected (see above).

The app therefore picks per recording: when the quiet gaps sit within 21 dB of the singing (a noisy room or microphone) it loads SwiftF0 through `onnxruntime-web` and says so; otherwise it uses the built-in tracker and never downloads the 11 MB runtime. If the model cannot load, the built-in tracker is used. Both feed the same note segmenter, and everything runs on the device.

Key detection also weighs where phrases come to rest (before a breath and at the end): tunes rest on the notes of the home chord. With that, `npm run benchmark:key` reaches 228/240 (95%) and the simulated singer's key is right in 56 of 64 takes.

## Research behind the changes

- [Mauch & Dixon: pYIN (2014)](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf): retaining pitch candidates and decoding them across time. The tracker borrows this approach; it is not a full reproduction of pYIN.
- [Simon, Morris & Basu: MySong (2008)](https://www.microsoft.com/en-us/research/publication/mysong-automatic-accompaniment-generation-for-vocal-melodies/): selecting an accompaniment as a sequence. Our chord transitions are explicit musical heuristics, not MySong's trained HMM.
- [music21 key-analysis documentation](https://www.music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html): duration-weighted Krumhansl–Schmuckler key profiles and alternate interpretations.
- [Nieradzik: SwiftF0 (2025)](https://arxiv.org/abs/2508.18440): the neural pitch tracker used for noisy recordings; its model file and licence are in `public/models/`.
- [Aarden (2003), via music21's key-analysis profiles](https://www.music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html): scale-degree distributions from sung folk melodies, used for key detection.
- [openvpi: GAME](https://github.com/openvpi/GAME): the singing-voice-to-score model the app now uses first; workflow in its `ONNX.md`.
- [Choi et al.: Children's Song Dataset (2020)](https://zenodo.org/records/4916302): score-labelled singing used to train the clean-up and to measure note accuracy.
- [Bittner et al.: vocadito (2021)](https://arxiv.org/abs/2110.05580): human note annotations for real solo vocals, including the distinction between tracking sung pitch and recognizing separate notes.
