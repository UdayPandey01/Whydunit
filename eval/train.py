#!/usr/bin/env python3
"""Fit one HistGradientBoosting classifier per split scheme.

A script, not a service: reads data/features.jsonl, writes data/model.pkl and
data/metrics.json, exits.

Hyperparameters are set once from defaults that suit ~800 rows and are NOT tuned
against test performance. If the model cannot beat a baseline, that is the result.
"""
import json
import pathlib
import pickle

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

DATA = pathlib.Path("data")
SCHEMES = ["mandate", "bank", "time"]
SEED = 20260903

# No class_weight="balanced" on purpose. Reweighting would lift macro-F1 on the
# small classes while wrecking the probability calibration that evaluate.py
# measures with ECE. The imbalance is real, so we report through it.
PARAMS = dict(
    max_iter=200,
    learning_rate=0.06,
    max_leaf_nodes=15,
    min_samples_leaf=20,
    l2_regularization=1.0,
    early_stopping=False,
    random_state=SEED,
)


def load():
    rows = [json.loads(l) for l in (DATA / "features.jsonl").open()]
    if not rows:
        raise SystemExit("data/features.jsonl is empty -- run `npm run features` first")
    names = sorted(rows[0]["features"])
    X = np.array(
        [[np.nan if r["features"][n] is None else r["features"][n] for n in names] for r in rows],
        dtype=float,
    )
    y = np.array([r["label"] for r in rows])
    return rows, names, X, y


def main():
    rows, names, X, y = load()
    models = {}
    metrics = {
        "n_rows": len(rows),
        "n_features": len(names),
        "feature_names": names,
        "params": {k: v for k, v in PARAMS.items()},
        "splits": {},
    }

    for scheme in SCHEMES:
        train = np.array([r["split"][scheme] == "train" for r in rows])
        clf = HistGradientBoostingClassifier(**PARAMS)
        clf.fit(X[train], y[train])
        models[scheme] = clf

        classes, counts = np.unique(y[train], return_counts=True)
        metrics["splits"][scheme] = {
            "n_train": int(train.sum()),
            "n_test": int((~train).sum()),
            "train_class_counts": {c: int(n) for c, n in zip(classes, counts)},
            "in_sample_accuracy": float((clf.predict(X[train]) == y[train]).mean()),
        }
        print(
            f"[train] {scheme:<8} fit on {int(train.sum()):>4} rows, "
            f"holding out {int((~train).sum()):>4}  "
            f"(in-sample acc {metrics['splits'][scheme]['in_sample_accuracy']:.3f})"
        )

    # Training-support envelope for the exception router. The deployed model is the
    # mandate-split one, so its training rows define what "seen before" means.
    train = np.array([r["split"]["mandate"] == "train" for r in rows])
    Xtr = X[train]
    support = {
        "reference_split": "mandate",
        "n_train": int(train.sum()),
        "banks": sorted({r["bank"] for r, t in zip(rows, train) if t}),
        "bank_train_counts": {
            b: sum(1 for r, t in zip(rows, train) if t and r["bank"] == b)
            for b in sorted({r["bank"] for r, t in zip(rows, train) if t})
        },
        "feature_range": {
            n: [
                None if np.isnan(np.nanmin(Xtr[:, i])) else float(np.nanmin(Xtr[:, i])),
                None if np.isnan(np.nanmax(Xtr[:, i])) else float(np.nanmax(Xtr[:, i])),
            ]
            for i, n in enumerate(names)
        },
    }
    (DATA / "support.json").write_text(json.dumps(support, indent=2) + "\n")
    print(f"[train] wrote data/support.json ({len(support['banks'])} banks, {len(names)} feature ranges)")

    with (DATA / "model.pkl").open("wb") as fh:
        pickle.dump({"models": models, "feature_names": names, "params": PARAMS}, fh)
    (DATA / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print(f"[train] wrote data/model.pkl ({len(models)} models) and data/metrics.json")


if __name__ == "__main__":
    main()
