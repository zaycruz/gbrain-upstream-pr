#!/usr/bin/env python3
"""Retrieval eval: run gold queries through gbrain search, score hit@5, hit@10, MRR.

CI usage (retrieval-gate.yml): against the hermetic fixture brain built from the
PR's code. --thresholds enforces the promotion gate and exits 1 on regression.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}


def query_date(q: str) -> str | None:
    m = re.search(r"\b(20\d\d)-(\d\d)-(\d\d)\b", q)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|"
        r"october|november|december)\s+(\d\d?)(?:,?\s+(20\d\d))?\b", q)
    if m:
        year = m.group(3) or "2026"
        return f"{year}-{MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    return None


def run_query(q: str, limit: int) -> tuple[list[str], str]:
    try:
        proc = subprocess.run(
            ["gbrain", "search", q, "--limit", str(limit)],
            capture_output=True, text=True, timeout=60,
        )
        output = proc.stdout + proc.stderr
        hits = re.findall(r"\[[\d.]+\]\s+(\S+)\s+--", output)
        return hits, output
    except Exception as e:  # noqa: BLE001 - eval must record, not crash
        return [], str(e)


def score(item: dict, hits: list[str], output: str) -> dict:
    golds = item["gold"]
    if golds:
        hit5 = any(any(g.lower() in h.lower() for g in golds) for h in hits[:5])
        hit10 = any(any(g.lower() in h.lower() for g in golds) for h in hits[:10])
        mrr = 0.0
        for rank, h in enumerate(hits[:10], 1):
            if any(g.lower() in h.lower() for g in golds):
                mrr = 1.0 / rank
                break
    else:
        # boundary queries: success = zero results or all top scores < 0.5
        scores = [float(m.group(1)) for m in re.finditer(r"\[([\d.]+)\]", output)]
        if not scores:
            hit5 = hit10 = True
        else:
            hit5 = all(s < 0.5 for s in scores[:5])
            hit10 = hit5
        mrr = 1.0 if hit5 else 0.0
    return {
        "id": item["id"], "cat": item["cat"], "q": item["q"], "gold": golds,
        "hits": hits[:10], "n_hits": len(hits),
        "hit5": hit5, "hit10": hit10, "mrr": round(mrr, 4),
        **({"date_probe": (query_date(item["q"]) in hits[0] if hits else False)}
           if query_date(item["q"]) and golds else {}),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--gold", default=os.path.join(here, "gold.json"))
    ap.add_argument("--out", default=os.path.join(here, "results.ndjson"))
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--thresholds", action="store_true",
                    help="enforce promotion gate: hit@5>=0.75, boundary>=0.80, MRR>=0.65")
    args = ap.parse_args()

    gold = json.load(open(args.gold))
    results = []
    for item in gold:
        hits, output = run_query(item["q"], args.limit)
        rec = score(item, hits, output)
        results.append(rec)
        status = "HIT" if rec["hit5"] else "MISS"
        print(f"[{rec['id']:3d}/{len(gold)}] {rec['cat']:12s} {status} ({rec['n_hits']:2d} hits)  {rec['q'][:60]}",
              file=sys.stderr, flush=True)

    with open(args.out, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")

    cats = defaultdict(list)
    for r in results:
        cats[r["cat"]].append(r)

    print("\n=== SUMMARY ===")
    print(f"{'Category':<15} {'N':>3} {'Hit@5':>7} {'Hit@10':>7} {'MRR':>7}")
    summary = {}
    for cat, rs in sorted(cats.items()):
        n = len(rs)
        h5 = sum(1 for r in rs if r["hit5"]) / n
        h10 = sum(1 for r in rs if r["hit10"]) / n
        mrr = sum(r["mrr"] for r in rs) / n
        summary[cat] = {"n": n, "hit5": h5, "hit10": h10, "mrr": mrr}
        print(f"{cat:<15} {n:>3} {h5:>7.1%} {h10:>7.1%} {mrr:>7.3f}")

    n = len(results)
    total = {
        "hit5": sum(1 for r in results if r["hit5"]) / n,
        "hit10": sum(1 for r in results if r["hit10"]) / n,
        "mrr": sum(r["mrr"] for r in results) / n,
    }
    print(f"{'TOTAL':<15} {n:>3} {total['hit5']:>7.1%} {total['hit10']:>7.1%} {total['mrr']:>7.3f}")

    probed = [r for r in results if "date_probe" in r]
    if probed:
        hits_with_probe = [r for r in probed if r["n_hits"] > 0]
        good = sum(1 for r in hits_with_probe if r["date_probe"])
        print(f"\n=== DATE PROBE ===")
        print(f"date-lookup queries with hits: {len(hits_with_probe)}, "
              f"top-hit slug carries queried date: {good}/{len(hits_with_probe)}")

    if args.thresholds:
        boundary = summary.get("boundary", {}).get("hit5", 0.0)
        ok = total["hit5"] >= 0.75 and boundary >= 0.80 and total["mrr"] >= 0.65
        gate = {
            "hit5": {"value": round(total["hit5"], 4), "min": 0.75},
            "boundary_rejection": {"value": round(boundary, 4), "min": 0.80},
            "mrr": {"value": round(total["mrr"], 4), "min": 0.65},
            "pass": ok,
        }
        print("\n=== GATE ===")
        print(json.dumps(gate, indent=2))
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
