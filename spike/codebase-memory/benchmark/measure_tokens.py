"""Extract real token usage per benchmark arm from Claude Code subagent transcripts.

Counts what the API actually billed, not an estimate. Cache reads are reported
separately from fresh input because they are priced differently and conflating
them would overstate any difference between arms.
"""
import json
import pathlib
import sys

BASE = pathlib.Path(
    "/Users/josemartinez/.claude/projects/"
    "-Users-josemartinez-Repositories-Personal-3-microservices-running-on-aws-infrastructure"
    "--claude-worktrees-chore-multi-tool-agent-improvements/"
    "d86ebf6e-d0ed-4738-a5e3-a2c66f12f295/subagents"
)

ARMS = {
    "A1 baseline (bench-arm-a)": "agent-abench-arm-a-2a1e90cb48896358.jsonl",
    "A1 directed (bench-arm-b)": "agent-abench-arm-b-d9042ce9aed167d8.jsonl",
    "A2 baseline (impact-arm-a)": "agent-aimpact-arm-a-3c2d872b020053a4.jsonl",
    "A2 directed (impact-arm-b)": "agent-aimpact-arm-b-89cd4ff5e2951e2c.jsonl",
    "A3 cheap-fix (cheap-fix-run)": "agent-acheap-fix-run-d66f3e4cf2a7ebf8.jsonl",
    "A4 graph (graph-arm)": None,  # resolved by glob at runtime
}


def resolve_graph_arm():
    """The graph arm's transcript name carries a random suffix; find it."""
    hits = sorted(BASE.glob("agent-agraph-arm-*.jsonl"))
    return hits[-1].name if hits else None


def totals(path):
    """Sum usage across every assistant turn in one agent's transcript."""
    t = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "turns": 0}
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        usage = (rec.get("message") or {}).get("usage") or rec.get("usage")
        if not isinstance(usage, dict):
            continue
        t["input"] += usage.get("input_tokens", 0) or 0
        t["output"] += usage.get("output_tokens", 0) or 0
        t["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
        t["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
        t["turns"] += 1
    return t


def main():
    rows = []
    for label, fname in ARMS.items():
        if fname is None:
            fname = resolve_graph_arm()
            if fname is None:
                continue
        t = totals(BASE / fname)
        if t is None:
            print(f"MISSING: {label} -> {fname}", file=sys.stderr)
            continue
        billed = t["input"] + t["cache_read"] + t["cache_write"]
        rows.append((label, t, billed))

    w = max(len(r[0]) for r in rows)
    hdr = f"{'arm'.ljust(w)}  {'turns':>5}  {'input':>8}  {'cache_rd':>9}  {'cache_wr':>9}  {'output':>7}  {'total_in':>9}"
    print(hdr)
    print("-" * len(hdr))
    for label, t, billed in rows:
        print(
            f"{label.ljust(w)}  {t['turns']:>5}  {t['input']:>8}  "
            f"{t['cache_read']:>9}  {t['cache_write']:>9}  {t['output']:>7}  {billed:>9}"
        )

    def pair(a, b, name):
        ra = next(r for r in rows if r[0].startswith(a))
        rb = next(r for r in rows if r[0].startswith(b))
        ta, tb = ra[2], rb[2]
        oa, ob = ra[1]["output"], rb[1]["output"]
        print(f"\n{name}")
        print(f"  total input  {ta:,} -> {tb:,}   ({(ta - tb) / ta * 100:+.1f}% change)")
        print(f"  output       {oa:,} -> {ob:,}   ({(oa - ob) / oa * 100:+.1f}% change)")
        print(f"  reduction    {(ta - tb) / ta * 100:.1f}% input, {(oa - ob) / oa * 100:.1f}% output")

    pair("A1 baseline", "A1 directed", "A1 — documented-knowledge questions (6)")
    pair("A2 baseline", "A2 directed", "A2 — change-impact questions (3)")
    try:
        pair("A2 baseline", "A4 graph", "A4 — same 3 questions, graph-assisted vs baseline")
        pair("A2 directed", "A4 graph", "A4 — graph-assisted vs the index-first arm")
    except StopIteration:
        pass


if __name__ == "__main__":
    main()
