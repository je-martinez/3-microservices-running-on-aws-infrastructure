import importlib.util
import re
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
SCRIPT = ROOT / "infra" / "environments" / "local" / "scripts" / "generate_env_files.py"
sys.path.insert(0, str(ROOT / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("generate_env_files", SCRIPT)
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)


def debug_spec(monkeypatch):
    monkeypatch.setattr(gen, "terraform_output", lambda tf_dir, name: "1")
    monkeypatch.setattr(gen, "discover_port", lambda *a, **k: 7001)
    monkeypatch.setattr(gen, "discover_assets_base_url", lambda *a, **k: "http://assets")
    return gen.build(ROOT)[ROOT / ".env.local.debug"]


def test_debug_has_browser_urls_and_openobserve_login(monkeypatch):
    spec = debug_spec(monkeypatch)
    g = spec["generated"]
    assert g["WEB_URL"] == "http://localhost:3004"
    assert g["OPENOBSERVE_URL"] == "http://localhost:5080"
    assert g["OPENOBSERVE_USER"] == "admin@3mrai.local"
    assert g["MAILPIT_URL"] == "http://localhost:8025"
    assert spec["mode"] == 0o600


def test_openobserve_login_matches_docker_compose():
    compose = (ROOT / "docker-compose.yml").read_text()
    assert f"ZO_ROOT_USER_PASSWORD={gen.OPENOBSERVE_PASSWORD}" in compose
    assert f"ZO_ROOT_USER_EMAIL={gen.OPENOBSERVE_USER}" in compose


def test_example_declares_every_debug_key(monkeypatch):
    files = {ROOT / ".env.local.debug": debug_spec(monkeypatch)}
    assert gen.check_example_covers(ROOT, files) == []


def test_write_applies_mode(monkeypatch, tmp_path):
    spec = debug_spec(monkeypatch)
    path = tmp_path / ".env.local.debug"
    gen.write_env_file(path, **spec)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
