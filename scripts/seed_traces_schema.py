#!/usr/bin/env python3
"""Seed the `gen_ai_*` fields into OpenObserve's traces stream schema.

WHY THIS EXISTS
---------------
OpenObserve's trace-detail view (the waterfall) calls
`/api/{org}/{stream}/traces/{trace_id}/dag`, and that endpoint SELECTs
`gen_ai_operation_name` unconditionally — a column belonging to its LLM-tracing
feature, which nothing in this repo emits. When the field is absent from the
stream's schema the whole query fails:

    HTTP 400  {"code":20004,"message":"Search field not found: Schema error:
               No field named gen_ai_operation_name."}

The failure is total, not partial: EVERY trace 400s, so the waterfall is simply
unavailable and the only place left to read a cascade is Jaeger. Measured on
2026-08-20 against v0.91.1 with 48,764 spans ingested — the data was all there
and none of it could be drawn.

Verified NOT to be a version bug: v0.92.2 (the latest release, 2026-08-17) was
run side by side on port 5081, fed the same 56 real spans, and returned the
identical 400. Upgrading fixes nothing.

What DOES fix it is the field merely EXISTING. OpenObserve infers a stream's
schema from ingested data, so one span carrying `gen_ai.*` attributes adds the
columns; every real span then reports them as null, which the DAG query is
perfectly happy with. After seeding, the same two traces returned HTTP 200 with
56 and 167 nodes.

Hence this script: ingest exactly one throwaway span whose only purpose is to
declare three columns.

WHY IT MUST BE AUTOMATED
------------------------
The schema lives in the `openobserve-data` volume, and `make clean` deletes it
(deliberately — see docker-compose.yml). A hand-run seed therefore survives
exactly until the next from-scratch rebuild, at which point the waterfall breaks
again with a message that points at a field nobody in this repo has ever heard
of. That is the same trap `observability-dashboards` fell into: a target that
existed, worked, and was invoked by nothing.

Idempotent: re-seeding just re-ingests one span. Run it on every
`observability-up`.

Node/pnpm are not involved — this is Python per the repo's scripting convention
(docs/shared/conventions/scripting-language.md). Standard library only, so it
needs no venv and can run before anything else is provisioned.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

# Defaults mirror the collector's own configuration (observability/otel-collector-config.yaml)
# and the local-dev credentials in docker-compose.yml. Overridable so the same
# script works against a non-local deployment.
O2_URL = os.environ.get("O2_URL", "http://localhost:5080")
O2_ORG = os.environ.get("O2_ORG", "3mrai")
O2_BASIC_AUTH = os.environ.get(
    "O2_BASIC_AUTH", "YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz"
)

# MUST match the collector's `stream-name` header for traces. Seeding the wrong
# stream is a silent no-op that looks like success: the ingest returns 200, the
# columns land on a stream nothing reads, and the DAG keeps 400ing. That exact
# mistake happened once during this investigation — the first seed went to
# `default` (0 docs) while the data was in `app_traces`.
TRACES_STREAM = os.environ.get("O2_TRACES_STREAM", "app_traces")

# The three columns the trace-detail view touches. `gen_ai_operation_name` is the
# one that breaks the DAG; the other two back the UI's "LLM calls" / "tool calls"
# quick filters, which fail the same way when clicked. Seeding all three costs
# one span and closes the whole class.
GEN_AI_ATTRIBUTES = ("gen_ai.operation_name", "gen_ai.system", "gen_ai.model_name")

# A span id of all zeros is INVALID per the W3C trace-context spec and some
# backends drop it, so the marker uses ...01 for both ids. It is a real, valid,
# self-contained span that belongs to no trace anyone will look at.
SEED_TRACE_ID = "0" * 31 + "1"
SEED_SPAN_ID = "0" * 15 + "1"
SEED_SERVICE = "schema-seed"
SEED_SPAN_NAME = "gen_ai_schema_seed"


def build_payload() -> dict:
    """One OTLP/JSON span carrying the gen_ai attributes and nothing else."""
    now_ns = int(time.time() * 1e9)
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": SEED_SERVICE}}
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "seed_traces_schema"},
                        "spans": [
                            {
                                "traceId": SEED_TRACE_ID,
                                "spanId": SEED_SPAN_ID,
                                "name": SEED_SPAN_NAME,
                                "kind": 1,
                                "startTimeUnixNano": str(now_ns),
                                "endTimeUnixNano": str(now_ns + 1000),
                                "attributes": [
                                    {"key": k, "value": {"stringValue": "seed"}}
                                    for k in GEN_AI_ATTRIBUTES
                                ],
                            }
                        ],
                    }
                ],
            }
        ]
    }


def schema_fields() -> list[str]:
    """Current column names on the traces stream, or [] if it does not exist yet."""
    url = f"{O2_URL}/api/{O2_ORG}/streams/{TRACES_STREAM}/schema?type=traces"
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {O2_BASIC_AUTH}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as exc:
        # 404 is the expected answer on a freshly cleaned volume: the stream is
        # created by the first ingest, which may not have happened yet. Not an error.
        if exc.code == 404:
            return []
        raise
    return [field["name"] for field in body.get("schema", [])]


def seed() -> None:
    url = f"{O2_URL}/api/{O2_ORG}/v1/traces"
    req = urllib.request.Request(
        url,
        data=json.dumps(build_payload()).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Basic {O2_BASIC_AUTH}",
            # The header that decides WHICH stream receives this. Without it the
            # span lands in `default` and the seed silently accomplishes nothing.
            "stream-name": TRACES_STREAM,
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status != 200:
            raise SystemExit(f"seed ingest returned HTTP {resp.status}")


def main() -> int:
    present = [f for f in schema_fields() if f.startswith("gen_ai")]
    if len(present) >= len(GEN_AI_ATTRIBUTES):
        print(f"traces schema already carries {len(present)} gen_ai_* field(s) — nothing to do")
        return 0

    seed()

    # The schema updates asynchronously after ingest, so confirm rather than
    # assume. A seed that reports success without the columns actually landing is
    # worse than a visible failure: the waterfall stays broken and this script
    # looks like it did its job.
    for _ in range(15):
        time.sleep(1)
        got = [f for f in schema_fields() if f.startswith("gen_ai")]
        if len(got) >= len(GEN_AI_ATTRIBUTES):
            print(f"seeded gen_ai_* into '{TRACES_STREAM}' — trace waterfall enabled")
            return 0

    # Non-fatal on purpose: the observability stack is opt-in and entirely
    # supplementary, so a seed that did not converge must not fail the target that
    # brings the stack up. It reports loudly and lets everything else proceed.
    print(
        f"warning: seeded '{TRACES_STREAM}' but gen_ai_* did not appear in the schema; "
        "OpenObserve's trace waterfall may return HTTP 400 (Jaeger is unaffected)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
