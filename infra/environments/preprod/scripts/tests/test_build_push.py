"""Tests for build_push.py — pre-prod image tags and docker command plans."""

import importlib.util
import json
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "build_push.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("build_push", SCRIPT)
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)

URL = "000000000000.dkr.ecr.us-east-1.localhost:4566/3mrai-preprod-app/users"


def test_clean_tree_tag_is_short_sha():
    assert bp.image_tag("abcdef1234567890", False, 0) == "abcdef123456"


def test_dirty_tags_differ_across_seconds():
    a = bp.image_tag("abcdef1234567890", True, 1000.0, "h1")
    b = bp.image_tag("abcdef1234567890", True, 1001.0, "h1")
    assert a != b and a.startswith("abcdef123456-dirty-")


def test_dirty_tags_differ_on_content_within_a_second():
    a = bp.image_tag("abcdef1234567890", True, 1000.0, "h1")
    b = bp.image_tag("abcdef1234567890", True, 1000.0, "h2")
    assert a != b


def test_built_service_commands():
    cmds = bp.commands_for("users", URL, "t1", {})
    assert cmds[0][:2] == ["docker", "build"]
    assert "services/users/Dockerfile" in cmds[0]
    assert cmds[-1] == ["docker", "push", f"{URL}:t1"]


def test_web_gets_build_args():
    cmds = bp.commands_for("web", URL, "t1", {"NG_APP_WS_URL": "ws://x"})
    assert "--build-arg" in cmds[0] and "NG_APP_WS_URL=ws://x" in cmds[0]


def test_web_build_enables_rum(monkeypatch):
    monkeypatch.setattr(bp, "terraform_output", lambda tf_dir, name: "ws://gw")
    args = bp._build_args("web", Path("/tf"))
    assert args["NG_APP_RUM_ENABLED"] == "true"
    assert args["NG_APP_WS_URL"] == "ws://gw"


def test_retagged_service_pulls_then_tags():
    cmds = bp.commands_for("mailpit", URL, "t1", {})
    assert cmds[0] == ["docker", "pull", "axllent/mailpit:v1.20"]
    assert cmds[1] == ["docker", "tag", "axllent/mailpit:v1.20", f"{URL}:t1"]


def test_update_tags_merges(tmp_path):
    path = tmp_path / "image-tags.auto.tfvars.json"
    path.write_text(json.dumps({"image_tags": {"users": "old", "orders": "o1"}}))
    assert bp.update_tags(path, {"users": "new"}) == {"users": "new", "orders": "o1"}
    assert json.loads(path.read_text())["image_tags"]["users"] == "new"


def test_repository_name_drops_the_registry_host():
    assert bp.repository_name(URL) == "3mrai-preprod-app/users"


def test_services_with_a_tag_in_ecr_are_skipped():
    present = {"users"}
    assert bp.services_to_push(["users", "orders"], lambda s: s in present) == ["orders"]


class _Ecr:
    def __init__(self, error=None, details=None):
        self.error, self.details, self.calls = error, details or [], []

    def describe_images(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise bp.ClientError({"Error": {"Code": self.error, "Message": ""}}, "DescribeImages")
        return {"imageDetails": self.details}


def test_tag_in_ecr_true_when_described():
    ecr = _Ecr(details=[{"imageTags": ["t1"]}])
    assert bp.tag_in_ecr(ecr, "r/users", "t1") is True
    assert ecr.calls == [{"repositoryName": "r/users", "imageIds": [{"imageTag": "t1"}]}]


def test_tag_in_ecr_false_on_image_not_found():
    assert bp.tag_in_ecr(_Ecr(error="ImageNotFoundException"), "r/users", "t1") is False


def test_tag_in_ecr_raises_other_errors():
    import pytest
    with pytest.raises(bp.ClientError):
        bp.tag_in_ecr(_Ecr(error="RepositoryNotFoundException"), "r/users", "t1")
