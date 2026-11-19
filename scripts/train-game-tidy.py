"""Train the clean-up stage that follows the GAME model (src/music/gameTidy.ts).

GAME writes a singer's scoop as a short extra note and sometimes splits a held
note. For every boundary between two touching notes this script learns, from
score-labelled singing, whether a new note really starts there.

Data: the Children's Song Dataset (CSD, CC BY-NC-SA 4.0, https://zenodo.org/records/4916302).
It is used for training and evaluation only and is not redistributed; the model
file holds weights, not recordings.

Inputs, produced by running the app's own GAME pipeline (src/music/game.ts) under Node:
  --notes  one or more JSON files: {"<name>.wav": [{startBeat, durationBeats, sungPitch}, ...]} in seconds
           with each note's encoder context in "<file>.feat/<name>.f32" (float32, 640 per note; 1280 for the larger model)
  --csd    the dataset root, holding CSD/english/csv, CSD/korean/csv
  --voicing  per-recording SwiftF0 output {conf: [...]} every 16 ms (to find where a note's voice begins)

A boundary is real when it is the detected onset nearest to a score note's onset
and within 100 ms of it. English songs 31-50 are the held-out test set and are
never read here. Cross-validation is by song over English songs 1-30.

The dataset's two halves share tunes: six held-out English songs are also sung in
Korean, and one has the tune of a development song. Those recordings (SHARED_TUNES)
are left out of training, so that no held-out melody is seen in any language.

Requires numpy and scikit-learn.

  python3 scripts/train-game-tidy.py --csd DIR --voicing DIR --notes english.json korean.json --out src/music/gameTidy.model.json

For GAME's larger model, give its notes (1280 context values per note), write to
src/music/gameTidy.large.model.json and pass --threshold 0.4, which the development songs preferred for it.
"""
import argparse
import csv
import json
import os

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

TOLERANCE = 0.1   # seconds: a detected onset this close to a score onset can be that note
TOUCHING = 0.03   # seconds: notes closer than this share a boundary
SEEDS = 3
HIDDEN = (64,)
ALPHA = 1.0
# Training songs with the tune of a held-out song (33, 39, 41, 42, 46, 48). Found by comparing the
# score's pitch steps, repeated notes merged: a match ratio of 0.6 or more (difflib.SequenceMatcher).
SHARED_TUNES = ['en001', 'kr001', 'kr035', 'kr037', 'kr040', 'kr041', 'kr044', 'kr050']


def score_notes(root, voicing, name):
    language = 'korean' if name.startswith('kr') else 'english'
    with open(os.path.join(root, 'CSD', language, 'csv', name + '.csv')) as handle:
        rows = [{'start': float(r['start']), 'end': float(r['end']), 'midi': int(r['pitch'])} for r in csv.DictReader(handle)]
    with open(os.path.join(voicing, name + '.json')) as handle:
        conf = json.load(handle)['conf']
    voiced = lambda frame: frame < len(conf) and conf[frame] >= 0.5
    for row in rows:
        # A note that opens with an unvoiced consonant starts where its voice does.
        first = round(row['start'] / 0.016)
        if voiced(first) or voiced(first + 1):
            continue
        for frame in range(first + 1, round(min(row['end'], row['start'] + 0.3) / 0.016) + 1):
            if voiced(frame) and voiced(frame + 1):
                row['start'] = frame * 0.016
                break
    return rows


def real_onsets(rows, notes):
    real, taken = set(), set()
    for _, i, j in sorted((abs(d['s'] - r['start']), i, j) for i, r in enumerate(rows) for j, d in enumerate(notes) if abs(d['s'] - r['start']) <= TOLERANCE):
        if i not in taken and j not in real:
            taken.add(i)
            real.add(j)
    return real


def note_features(notes, i):
    """Must match boundaryFeatures() in src/music/gameTidy.ts, after the 640 context values."""
    a, b = notes[i - 1], notes[i]
    p = notes[i - 2] if i > 1 else None
    n = notes[i + 1] if i + 1 < len(notes) else None
    da, db, step = a['e'] - a['s'], b['e'] - b['s'], b['p'] - a['p']
    return [da, db, np.log(da + .01), np.log(db + .01), da / (da + db), np.clip(step, -8, 8), min(abs(step), 8),
            abs(a['p'] - round(a['p'])), abs(b['p'] - round(b['p'])),
            (p['e'] - p['s']) if p else 1., min(1., a['s'] - p['e']) if p else 1., np.clip(p['p'] - a['p'], -8, 8) if p else 0.,
            (n['e'] - n['s']) if n else 1., min(1., n['s'] - b['e']) if n else 1., np.clip(n['p'] - b['p'], -8, 8) if n else 0.]


def fit(x, y):
    """Three small networks and a forest of boosted trees; their answers are averaged."""
    scaler = StandardScaler().fit(x)
    members = [MLPClassifier(hidden_layer_sizes=HIDDEN, alpha=ALPHA, max_iter=400, early_stopping=True, random_state=seed).fit(scaler.transform(x), y) for seed in range(SEEDS)]
    forest = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, max_leaf_nodes=15, l2_regularization=1.0).fit(x, y)
    return scaler, members, forest


def probability(scaler, members, forest, x):
    networks = np.mean([member.predict_proba(scaler.transform(x))[:, 1] for member in members], 0)
    return (networks + forest.predict_proba(x)[:, 1]) / 2


def export_forest(forest):
    """Each tree as a node list: a leaf is [value], a branch is [input, threshold, left, right]."""
    trees = []
    for (predictor,) in forest._predictors:
        trees.append([[round(float(node['value']), 7)] if node['is_leaf'] else
                      [int(node['feature_idx']), float(node['num_threshold']), int(node['left']), int(node['right'])] for node in predictor.nodes])
    return {'base': round(float(forest._baseline_prediction.ravel()[0]), 5), 'trees': trees}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--csd', required=True)
    parser.add_argument('--voicing', required=True)
    parser.add_argument('--notes', nargs='+', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--threshold', type=float, default=0.5)
    parser.add_argument('--exclude', nargs='*', default=SHARED_TUNES, help='recordings to leave out, by name prefix')
    args = parser.parse_args()

    x, y, song = [], [], []
    for path in args.notes:
        with open(path) as handle:
            takes = json.load(handle)
        for file, raw in sorted(takes.items()):
            name = file[:-4]
            english = name.startswith('en')
            if english and int(name[2:5]) > 30:
                continue  # held out
            if any(name.startswith(prefix) for prefix in args.exclude):
                continue  # the same tune as a held-out song
            notes = [{'s': v['startBeat'], 'e': v['startBeat'] + v['durationBeats'], 'p': v['sungPitch']} for v in raw]
            context = np.fromfile(os.path.join(path + '.feat', name + '.f32'), dtype=np.float32).reshape(len(notes), -1)
            real = real_onsets(score_notes(args.csd, args.voicing, name), notes)
            for i in range(1, len(notes)):
                if notes[i]['s'] - notes[i - 1]['e'] > TOUCHING:
                    continue
                x.append(np.concatenate([context[i], note_features(notes, i)]))
                y.append(1 if i in real else 0)
                song.append(int(name[2:5]) if english else -1)
    x, y, song = np.array(x), np.array(y), np.array(song)
    print(f'{len(y)} boundaries, {100 * y.mean():.1f}% real; {int((song < 0).sum())} from Korean recordings')

    # Cross-validation by song over the English development songs (Korean always in training).
    english_songs = sorted(set(song[song > 0]))
    fold = np.array([english_songs.index(s) % 5 if s > 0 else -1 for s in song])
    right = total = 0
    for k in range(5):
        test = fold == k
        predicted = probability(*fit(x[~test], y[~test]), x[test]) >= args.threshold
        right += int((predicted == (y[test] == 1)).sum())
        total += int(test.sum())
    print(f'cross-validated boundary decisions right: {100 * right / total:.1f}%')

    scaler, members, forest = fit(x, y)
    model = {
        'threshold': args.threshold,
        'mean': [round(float(v), 5) for v in scaler.mean_],
        'scale': [round(max(float(v), 1e-4), 5) for v in scaler.scale_],
        'members': [[{'weights': [[round(float(w), 4) for w in column] for column in weights.T], 'bias': [round(float(b), 4) for b in bias]}
                     for weights, bias in zip(member.coefs_, member.intercepts_)] for member in members],
        'forest': export_forest(forest),
    }
    with open(args.out, 'w') as handle:
        json.dump(model, handle, separators=(',', ':'))
    print(f'wrote {args.out} ({os.path.getsize(args.out) // 1024} KB)')


if __name__ == '__main__':
    main()
