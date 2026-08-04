"""Tests for lib3mrai.execution_log — the three cases the design requires.

No real DynamoDB is touched: `lib3mrai.execution_log.aws.client` is patched, so
these run offline and cannot write to (or depend on) the live Floci table. The
third case in particular — DynamoDB unreachable — is simulated by making the
patched client's calls raise, which is the point: proving the fail-open behavior
must not require actually breaking the local emulator.

See docs/superpowers/specs/2026-07-30-post-infra-root-design.md ("Failure
semantics") for why the unreachable case is the guarantee the whole design rests
on.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from lib3mrai.execution_log import TABLE_ENV_VAR, record_execution

TABLE = "3mrai-local-tfstate-execution-log"
SCRIPT = "fake.py"
RESOURCE = "cluster-123"


@pytest.fixture
def table_env(monkeypatch):
    """Point the helper at a table name, as the local-exec env blocks will."""
    monkeypatch.setenv(TABLE_ENV_VAR, TABLE)


@pytest.fixture
def ddb():
    """A stand-in DynamoDB client, patched at the module's own `aws.client`."""
    fake = MagicMock()
    with patch("lib3mrai.execution_log.aws.client", return_value=fake):
        yield fake


def _kwargs(mock_method):
    """The kwargs of a mocked method's single call.

    Note `mock_method.kwargs` would silently return a child mock (every
    attribute of a MagicMock is one), so assertions against it always pass
    against a mock instead of the real value — `.call_args.kwargs` is the
    accessor that actually reads the recorded call.
    """
    return mock_method.call_args.kwargs


def test_successful_run_is_recorded(table_env, ddb):
    """A clean run opens a 'running' record and closes it as 'ok'."""
    ran = False

    with record_execution(script=SCRIPT, resource_id=RESOURCE):
        ran = True

    assert ran is True

    ddb.put_item.assert_called_once()
    item = _kwargs(ddb.put_item)["Item"]
    assert _kwargs(ddb.put_item)["TableName"] == TABLE
    assert item["script_name"]["S"] == SCRIPT
    assert item["status"]["S"] == "running"
    assert item["resource_id"]["S"] == RESOURCE
    # The sort key carries the resource identity, so a recreated resource starts
    # a fresh, distinguishable history instead of colliding with its predecessor.
    assert item["run_key"]["S"].startswith(f"{RESOURCE}#")
    assert item["started_at"]["S"]
    assert item["content_hash"]["S"] != "unavailable"

    ddb.update_item.assert_called_once()
    update = _kwargs(ddb.update_item)
    values = update["ExpressionAttributeValues"]
    assert values[":status"]["S"] == "ok"
    assert values[":ended_at"]["S"]
    assert values[":exit_code"]["N"] == "0"
    # No stderr key on success — the design records stderr on failure only.
    assert ":stderr" not in values
    assert "stderr" not in update["UpdateExpression"]
    # The closing record must target the same row the opening one created.
    assert update["Key"]["run_key"]["S"] == item["run_key"]["S"]


def test_failed_run_records_the_error_and_reraises(table_env, ddb):
    """A raising body closes the record as 'failed' and propagates unchanged."""
    with pytest.raises(RuntimeError, match="boom"):
        with record_execution(script=SCRIPT, resource_id=RESOURCE):
            raise RuntimeError("boom")

    ddb.update_item.assert_called_once()
    update = _kwargs(ddb.update_item)
    values = update["ExpressionAttributeValues"]
    assert values[":status"]["S"] == "failed"
    assert values[":exit_code"]["N"] == "1"
    assert "boom" in values[":stderr"]["S"]
    assert values[":ended_at"]["S"]


def test_dynamodb_unreachable_does_not_break_the_script(table_env, capsys):
    """THE load-bearing case: a dead log must not stop provisioning.

    Both writes fail, as they would with Floci down. The wrapped body must still
    run, nothing may propagate out of the context manager, and the operator must
    be warned on stderr.
    """
    fake = MagicMock()
    fake.put_item.side_effect = OSError("Could not connect to the endpoint URL")
    fake.update_item.side_effect = OSError("Could not connect to the endpoint URL")

    ran = False
    with patch("lib3mrai.execution_log.aws.client", return_value=fake):
        with record_execution(script=SCRIPT, resource_id=RESOURCE):
            ran = True

    assert ran is True

    # console.no writes to stderr; both the opening and closing failures warn.
    err = capsys.readouterr().err
    assert "execution_log: could not write 'running' record" in err
    assert "execution_log: could not write 'ok' record" in err


def test_client_construction_failure_also_fails_open(table_env, capsys):
    """Fail-open covers a client that cannot even be built, not just a failed call."""
    ran = False
    with patch(
        "lib3mrai.execution_log.aws.client",
        side_effect=OSError("no endpoint"),
    ):
        with record_execution(script=SCRIPT, resource_id=RESOURCE):
            ran = True

    assert ran is True
    assert "execution_log" in capsys.readouterr().err


def test_unset_table_skips_logging_but_still_runs(monkeypatch, ddb):
    """Running a script by hand, outside the chain, records nothing and works."""
    monkeypatch.delenv(TABLE_ENV_VAR, raising=False)

    ran = False
    with record_execution(script=SCRIPT, resource_id=RESOURCE):
        ran = True

    assert ran is True
    ddb.put_item.assert_not_called()
    ddb.update_item.assert_not_called()
