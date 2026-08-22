#!/usr/bin/env python3
"""Full evaluation battery for the cause classifier.

Per-class precision/recall/F1, macro-F1, confusion matrix, calibration curve and
ECE, each with a 1000-sample bootstrap 95% CI, for all three split schemes, plus
two classification baselines.

The bootstrap resamples MANDATES, not rows. Attempts on one mandate share a
customer, a balance trajectory and a churn state, so a row-level bootstrap would
treat correlated rows as independent and report intervals that are too narrow.

Also writes out-of-fold predictions over every row (GroupKFold by mandate) for the
recovery-policy comparison in src/policy.ts, so that comparison runs on 1098
out-of-sample rows instead of one 296-row test split.
"""
import json
import pathlib
import pickle

import numpy as np
from sklearn.base import clone
from sklearn.model_selection import GroupKFold

DATA = pathlib.Path("data")
CLASSES = ["C1_EXECUTION_WINDOW", "C2_NOTIFICATION_FAIL", "C3_BALANCE_SHORTFALL", "C4_CANCELLATION"]
SHORT = {c: c.split("_")[0] for c in CLASSES}
SCHEMES = ["mandate", "bank", "time"]
CODES = ["Z9", "U30", "U69", "ZM", "ZA"]
N_BOOT = 1000
SEED = 20260903


def prf(y_true, y_pred):
    """Per-class precision/recall/F1 over the fixed class list, plus macro-F1."""
    out = {}
    f1s = []
    for c in CLASSES:
        tp = int(((y_pred == c) & (y_true == c)).sum())
        fp = int(((y_pred == c) & (y_true != c)).sum())
        fn = int(((y_pred != c) & (y_true == c)).sum())
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f = 2 * p * r / (p + r) if p + r else 0.0
        out[c] = {"precision": p, "recall": r, "f1": f, "support": tp + fn}
        f1s.append(f)
    out["macro_f1"] = float(np.mean(f1s))
    out["accuracy"] = float((y_pred == y_true).mean()) if len(y_true) else 0.0
    return out


def ece(y_true, y_pred, conf, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    curve = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi) if lo > 0 else (conf >= lo) & (conf <= hi)
        if not m.any():
            continue
        acc = float((y_pred[m] == y_true[m]).mean())
        c = float(conf[m].mean())
        total += m.sum() / len(conf) * abs(acc - c)
        curve.append({"bin": [float(lo), float(hi)], "n": int(m.sum()), "confidence": c, "accuracy": acc})
    return float(total), curve


def cluster_bootstrap(y_true, y_pred, groups, conf=None, n=N_BOOT, seed=SEED):
    """Resample mandates with replacement; return every headline metric's draws."""
    rng = np.random.default_rng(seed)
    uniq = np.unique(groups)
    idx_by_group = {g: np.where(groups == g)[0] for g in uniq}
    draws = {"macro_f1": [], "accuracy": [], "ece": []}
    for c in CLASSES:
        draws[f"{c}:precision"], draws[f"{c}:recall"], draws[f"{c}:f1"] = [], [], []

    for _ in range(n):
        pick = rng.choice(uniq, size=len(uniq), replace=True)
        idx = np.concatenate([idx_by_group[g] for g in pick])
        m = prf(y_true[idx], y_pred[idx])
        draws["macro_f1"].append(m["macro_f1"])
        draws["accuracy"].append(m["accuracy"])
        for c in CLASSES:
            for k in ("precision", "recall", "f1"):
                draws[f"{c}:{k}"].append(m[c][k])
        draws["ece"].append(ece(y_true[idx], y_pred[idx], conf[idx])[0] if conf is not None else np.nan)

    return {k: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] for k, v in draws.items()}


def confusion(y_true, y_pred):
    return [[int(((y_true == a) & (y_pred == b)).sum()) for b in CLASSES] for a in CLASSES]


def expert_rule(rows, idx):
    """Hand-written expert rule over published/obvious signals, in world precedence."""
    out = []
    for i in np.where(idx)[0]:
        f = rows[i]["features"]
        if f.get("revoked_before_attempt") == 1:
            out.append("C4_CANCELLATION")
        elif f.get("receipt_delivered") == 0 or f.get("notify_lead_under_24") == 1:
            out.append("C2_NOTIFICATION_FAIL")
        elif f.get("in_restricted_window") == 1:
            out.append("C1_EXECUTION_WINDOW")
        else:
            out.append("C3_BALANCE_SHORTFALL")
    return np.array(out)


def paired_macro_f1_delta(y_true, pred_a, pred_b, groups, n=N_BOOT, seed=SEED):
    """Resample mandates once, score BOTH predictors on the same resample.

    Overlapping independent CIs is a weaker and more conservative test than asking
    whether the difference itself excludes zero, so the difference is what we
    report when deciding if a model beats a baseline.
    """
    rng = np.random.default_rng(seed)
    uniq = np.unique(groups)
    idx_by_group = {g: np.where(groups == g)[0] for g in uniq}
    draws = []
    for _ in range(n):
        pick = rng.choice(uniq, size=len(uniq), replace=True)
        idx = np.concatenate([idx_by_group[g] for g in pick])
        draws.append(prf(y_true[idx], pred_a[idx])["macro_f1"] - prf(y_true[idx], pred_b[idx])["macro_f1"])
    return {
        "delta": float(prf(y_true, pred_a)["macro_f1"] - prf(y_true, pred_b)["macro_f1"]),
        "ci": [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))],
    }


def code_of(row):
    for c in CODES:
        if row["features"].get(f"code_{c}") == 1:
            return c
    return "NONE"


def fmt_ci(v, ci):
    return f"{v:.3f} [{ci[0]:.3f}, {ci[1]:.3f}]"


def main():
    rows = [json.loads(l) for l in (DATA / "features.jsonl").open()]
    with (DATA / "model.pkl").open("rb") as fh:
        bundle = pickle.load(fh)
    names = bundle["feature_names"]

    X = np.array(
        [[np.nan if r["features"][n] is None else r["features"][n] for n in names] for r in rows],
        dtype=float,
    )
    y = np.array([r["label"] for r in rows])
    groups = np.array([r["mandate_id"] for r in rows])
    codes = np.array([code_of(r) for r in rows])
    explicit = np.array([r["diag_explicit_churn"] for r in rows])

    report = {"n_rows": len(rows), "n_bootstrap": N_BOOT, "schemes": {}}

    for scheme in SCHEMES:
        clf = bundle["models"][scheme]
        te = np.array([r["split"][scheme] == "test" for r in rows])
        tr = ~te
        yt, yp = y[te], clf.predict(X[te])
        proba = clf.predict_proba(X[te])
        conf = proba.max(axis=1)

        m = prf(yt, yp)
        e, curve = ece(yt, yp, conf)
        ci = cluster_bootstrap(yt, yp, groups[te], conf)

        # Baselines on the same test rows, fit on the same training rows.
        majority = np.full(te.sum(), max(CLASSES, key=lambda c: (y[tr] == c).sum()))
        lookup = {}
        for c in np.unique(codes[tr]):
            sub = y[tr][codes[tr] == c]
            lookup[c] = max(CLASSES, key=lambda k: (sub == k).sum()) if len(sub) else CLASSES[0]
        code_pred = np.array([lookup.get(c, CLASSES[0]) for c in codes[te]])

        rule_pred = expert_rule(rows, te)
        base = {}
        for name, pred in (("majority_class", majority), ("decline_code_lookup", code_pred), ("expert_rule", rule_pred)):
            bm = prf(yt, pred)
            bci = cluster_bootstrap(yt, pred, groups[te])
            base[name] = {
                "macro_f1": bm["macro_f1"], "macro_f1_ci": bci["macro_f1"],
                "accuracy": bm["accuracy"], "accuracy_ci": bci["accuracy"],
            }

        report["schemes"][scheme] = {
            "n_test": int(te.sum()),
            "accuracy": m["accuracy"], "accuracy_ci": ci["accuracy"],
            "macro_f1": m["macro_f1"], "macro_f1_ci": ci["macro_f1"],
            "ece": e, "ece_ci": ci["ece"],
            "per_class": {
                c: {
                    "support": m[c]["support"],
                    "precision": m[c]["precision"], "precision_ci": ci[f"{c}:precision"],
                    "recall": m[c]["recall"], "recall_ci": ci[f"{c}:recall"],
                    "f1": m[c]["f1"], "f1_ci": ci[f"{c}:f1"],
                }
                for c in CLASSES
            },
            "confusion_matrix": {"labels": CLASSES, "rows_are_true": confusion(yt, yp)},
            "calibration_curve": curve,
            "baselines": base,
            "model_minus_expert_rule": paired_macro_f1_delta(yt, yp, rule_pred, groups[te]),
        }

        print(f"\n=== split: {scheme}  (test n={int(te.sum())}) ===")
        print(f"  accuracy  {fmt_ci(m['accuracy'], ci['accuracy'])}")
        print(f"  macro-F1  {fmt_ci(m['macro_f1'], ci['macro_f1'])}")
        print(f"  ECE       {fmt_ci(e, ci['ece'])}")
        print(f"  {'class':<22}{'support':>8}{'precision':>22}{'recall':>22}{'F1':>22}")
        for c in CLASSES:
            print(
                f"  {SHORT[c]:<22}{m[c]['support']:>8}"
                f"{fmt_ci(m[c]['precision'], ci[f'{c}:precision']):>22}"
                f"{fmt_ci(m[c]['recall'], ci[f'{c}:recall']):>22}"
                f"{fmt_ci(m[c]['f1'], ci[f'{c}:f1']):>22}"
            )
        print(f"  confusion (rows=true, cols=pred, order {[SHORT[c] for c in CLASSES]}):")
        for c, r in zip(CLASSES, confusion(yt, yp)):
            print(f"    {SHORT[c]:<4}{str(r):>24}")
        for name, b in base.items():
            print(f"  baseline {name:<22} macro-F1 {fmt_ci(b['macro_f1'], b['macro_f1_ci'])}")
        d = report["schemes"][scheme]["model_minus_expert_rule"]
        verdict = "NOT distinguishable" if d["ci"][0] <= 0 <= d["ci"][1] else "distinguishable"
        print(f"  PAIRED  model - expert_rule macro-F1  {d['delta']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}]  <- {verdict}")

    # ---- diagnostic: is C4 only working because of the revoke webhook? ----
    mandate_te = np.array([r["split"]["mandate"] == "test" for r in rows])
    yp_m = bundle["models"]["mandate"].predict(X[mandate_te])
    yt_m, ex_m = y[mandate_te], explicit[mandate_te]
    c4 = yt_m == "C4_CANCELLATION"
    diag = {
        "c4_explicit_n": int((c4 & ex_m).sum()),
        "c4_explicit_recall": float((yp_m[c4 & ex_m] == "C4_CANCELLATION").mean()) if (c4 & ex_m).any() else None,
        "c4_silent_n": int((c4 & ~ex_m).sum()),
        "c4_silent_recall": float((yp_m[c4 & ~ex_m] == "C4_CANCELLATION").mean()) if (c4 & ~ex_m).any() else None,
    }
    report["c4_diagnostic"] = diag
    print("\n=== C4 diagnostic (mandate split) ===")
    print(f"  explicit revoke webhook  n={diag['c4_explicit_n']:>3}  recall {diag['c4_explicit_recall']}")
    print(f"  silent churn             n={diag['c4_silent_n']:>3}  recall {diag['c4_silent_recall']}")

    # ---- out-of-fold predictions over every row, for the policy comparison ----
    oof_pred = np.empty(len(rows), dtype=object)
    oof_proba = np.zeros((len(rows), len(CLASSES)))
    for tr_i, te_i in GroupKFold(n_splits=5).split(X, y, groups):
        clf = clone(bundle["models"]["mandate"])
        clf.fit(X[tr_i], y[tr_i])
        oof_pred[te_i] = clf.predict(X[te_i])
        p = clf.predict_proba(X[te_i])
        for j, c in enumerate(clf.classes_):
            oof_proba[te_i, CLASSES.index(c)] = p[:, j]

    oof = prf(y, oof_pred)
    oof_ci = cluster_bootstrap(y, oof_pred, groups)
    report["out_of_fold"] = {
        "n": len(rows),
        "macro_f1": oof["macro_f1"], "macro_f1_ci": oof_ci["macro_f1"],
        "accuracy": oof["accuracy"], "accuracy_ci": oof_ci["accuracy"],
        "per_class": {c: {"f1": oof[c]["f1"], "f1_ci": oof_ci[f"{c}:f1"], "support": oof[c]["support"]} for c in CLASSES},
    }
    print(f"\n=== out-of-fold over all {len(rows)} rows (5-fold, grouped by mandate) ===")
    print(f"  accuracy  {fmt_ci(oof['accuracy'], oof_ci['accuracy'])}")
    print(f"  macro-F1  {fmt_ci(oof['macro_f1'], oof_ci['macro_f1'])}")

    rule_all = expert_rule(rows, np.ones(len(rows), dtype=bool))
    report["out_of_fold"]["model_minus_expert_rule"] = paired_macro_f1_delta(y, oof_pred, rule_all, groups)
    d = report["out_of_fold"]["model_minus_expert_rule"]
    print(f"  PAIRED  model - expert_rule macro-F1  {d['delta']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}]")

    with (DATA / "predictions.jsonl").open("w") as fh:
        for i, r in enumerate(rows):
            fh.write(json.dumps({
                "attempt_id": r["attempt_id"],
                "mandate_id": r["mandate_id"],
                "actual": r["label"],
                "predicted": oof_pred[i],
                "rule_predicted": rule_all[i],
                # Rounded at the serialization boundary, NOT in the computation.
                # float64 repr is not portable: the same deterministic fit differs
                # in the last bit between BLAS backends (arm64 vs the x86 CI
                # runner), which made an artifact hash fail while every class,
                # every decision and every downstream artifact were identical.
                # 6 dp sits ~11 orders above that noise and ~3 below the tightest
                # threshold anything downstream uses. Rows need not sum to exactly
                # 1 afterwards; nothing consumes them as a normalised distribution.
                "proba": {c: round(float(oof_proba[i, j]), 6) for j, c in enumerate(CLASSES)},
            }) + "\n")

    (DATA / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"\n[eval] wrote data/evaluation.json and data/predictions.jsonl")


if __name__ == "__main__":
    main()
