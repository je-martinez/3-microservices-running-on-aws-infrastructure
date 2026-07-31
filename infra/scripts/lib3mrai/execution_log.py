"""Traceability log for the awscli-fallback local-exec scripts.

NOT a skip-on-record cache — see docs/shared/patterns/awscli-fallback-for-floci.md
and the "DynamoDB execution log" section of
docs/superpowers/specs/2026-07-30-post-infra-root-design.md for why: the four
scripts this wraps are already idempotent on their own terms (CREATE ... IF NOT
EXISTS, lookup-then-reuse, declarative UpdateUserPool), and `make clean` destroys
and recreates the underlying resources routinely. A record that caused a skip
would leave a recreated resource unprovisioned while looking "already done" —
strictly worse than today. So `record_execution` NEVER skips; it always lets the
wrapped block run, and only records the outcome.

Key shape: partition key `script_name`, sort key `run_key` = "<resource_id>#<start
timestamp, ISO 8601>" — the resource id keeps a recreated resource's history
distinguishable from its predecessor's without needing to inspect record bodies.

Record contents (per the design's "Record contents"): script name, content hash,
start/end timestamps, exit code, stderr on failure, resource identity, status.
Status starts at "running" and closes to "ok" or "failed": a row left permanently
at "running" is legible evidence of an interrupted run (Ctrl-C, machine slept)
rather than a mystery, which writing only the final record would erase entirely.

Failure semantics:
  - DynamoDB unreachable: warn to stderr (lib3mrai.console.no) and let the
    wrapped block run anyway. A traceability aid must not make provisioning
    newly fragile.
  - The wrapped block raises: the record closes as "failed" with the exception's
    string and re-raises unchanged — callers see the exact same failure they
    would without this wrapper.
"""

from __future__ import annotations

import contextlib
import hashlib
import inspect
import os
import traceback
from datetime import datetime, timezone

from . import aws
from .console import no

TABLE_ENV_VAR = "EXECUTION_LOG_TABLE"

# Ceiling on the recorded error text. DynamoDB caps an item at 400 KB, and a
# runaway traceback in a record nobody reads is not worth risking the write for.
MAX_STDERR_CHARS = 2000

# The exit code the record carries. These scripts all use the 0-success /
# non-zero-failure convention, and the wrapper only ever observes "the body
# raised" or "the body returned", so it records the two codes that correspond.
EXIT_OK = 0
EXIT_FAILED = 1


def _table_name() -> str | None:
    """The configured table, or None when the log is simply not wired up.

    An unset variable is a legitimate state, not an error: a script run by hand
    outside the Makefile/Terraform chain records nothing and behaves exactly as
    it did before this module existed.
    """
    return os.environ.get(TABLE_ENV_VAR) or None


def _content_hash(path: str) -> str:
    """Short sha256 of the calling script, to detect "the script changed since".

    Returns "unavailable" rather than raising if the file cannot be read — the
    hash is a diagnostic nicety, and losing it must never cost a record.
    """
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return "unavailable"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextlib.contextmanager
def record_execution(script: str, resource_id: str):
    """Wrap a provisioning script's body. ALWAYS runs the body — see module docstring.

    `script` — the script's own filename (e.g. "create_mysql_database.py").
    `resource_id` — identity of the resource acted on (cluster id, user pool id).
    """
    table = _table_name()
    start = _now()
    run_key = f"{resource_id}#{start}"

    # Resolve the calling script's own file path for the content hash, without
    # requiring every caller to pass it explicitly.
    caller_file = inspect.stack()[1].filename
    content_hash = _content_hash(caller_file)

    item = {
        "script_name": {"S": script},
        "run_key": {"S": run_key},
        "resource_id": {"S": resource_id},
        "content_hash": {"S": content_hash},
        "started_at": {"S": start},
        "status": {"S": "running"},
    }

    ddb = None
    if table is not None:
        try:
            ddb = aws.client("dynamodb")
            ddb.put_item(TableName=table, Item=item)
        except Exception as exc:  # noqa: BLE001 — traceability must not be fragile
            no(f"execution_log: could not write 'running' record: {exc}")
            ddb = None

    failed_with: str | None = None
    try:
        yield
    except Exception as exc:  # noqa: BLE001 — re-raised below unchanged
        failed_with = "".join(
            traceback.format_exception_only(type(exc), exc)
        ).strip()
        raise
    finally:
        end = _now()
        status = "failed" if failed_with else "ok"
        exit_code = EXIT_FAILED if failed_with else EXIT_OK
        if table is not None:
            try:
                # `ddb` is None when the opening put_item failed. Rebuilding the
                # client here means a DynamoDB blip during the wrapped body does
                # not permanently lose the closing record too.
                ddb = ddb or aws.client("dynamodb")
                values = {
                    ":status": {"S": status},
                    ":ended_at": {"S": end},
                    ":exit_code": {"N": str(exit_code)},
                }
                # `status` is a DynamoDB reserved word, hence the #s alias.
                expr = "SET #s = :status, ended_at = :ended_at, exit_code = :exit_code"
                if failed_with:
                    values[":stderr"] = {"S": failed_with[:MAX_STDERR_CHARS]}
                    expr += ", stderr = :stderr"
                ddb.update_item(
                    TableName=table,
                    Key={"script_name": {"S": script}, "run_key": {"S": run_key}},
                    UpdateExpression=expr,
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues=values,
                )
            except Exception as exc:  # noqa: BLE001 — same fail-open rule
                no(f"execution_log: could not write '{status}' record: {exc}")
