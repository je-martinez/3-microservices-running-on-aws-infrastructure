#!/usr/bin/env python3
"""WORKAROUND(local): Do NOT remove this seed from observability-up.
OpenObserve on localhost:5080 returns HTTP 400 for every trace waterfall when
its inferred schema lacks gen_ai_operation_name; one throwaway span adds it.
`make clean` deletes the schema volume, so the seed must be idempotent.
See [[ADR-0018-observability-openobserve]]
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

# CONTRACT: Do NOT seed a different stream. Ingest still returns 200, but the
# trace DAG keeps returning HTTP 400 because its schema remains unchanged.
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
        "OpenObserve's trace waterfall may return HTTP 400",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
