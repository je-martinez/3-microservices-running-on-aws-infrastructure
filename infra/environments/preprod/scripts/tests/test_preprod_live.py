"""Tests for preprod_live.py — preprod-up refuses on a live environment."""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_live.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("preprod_live", SCRIPT)
pl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pl)


class FakeEcs:
    def __init__(self, arns=(), error=None):
        self.arns, self.error = list(arns), error

    def list_services(self, cluster):
        if self.error:
            raise pl.ClientError({"Error": {"Code": self.error, "Message": ""}}, "ListServices")
        return {"serviceArns": self.arns}


def test_refuses_when_the_cluster_has_services():
    assert pl.check("c", lambda: FakeEcs(["arn:svc/users"])) == 1


def test_passes_when_the_cluster_is_empty():
    assert pl.check("c", lambda: FakeEcs()) == 0


def test_passes_when_the_cluster_does_not_exist():
    assert pl.check("c", lambda: FakeEcs(error="ClusterNotFoundException")) == 0


def test_other_ecs_errors_propagate():
    with pytest.raises(pl.ClientError):
        pl.check("c", lambda: FakeEcs(error="AccessDeniedException"))


def test_no_state_means_from_scratch_without_calling_ecs(tmp_path):
    def boom():
        raise AssertionError("ECS called")
    assert pl.check(pl.cluster_name(tmp_path), boom) == 0


def test_cluster_name_reads_the_output_when_state_exists(tmp_path):
    (tmp_path / "terraform.tfstate").write_text("{}")
    ok = lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="3mrai-preprod-ecs\n", stderr="")
    missing = lambda *a, **k: subprocess.CompletedProcess(a, 1, stdout="", stderr="no output")
    assert pl.cluster_name(tmp_path, ok) == "3mrai-preprod-ecs"
    assert pl.cluster_name(tmp_path, missing) is None
