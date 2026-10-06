import importlib.util
import stat
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_debug_env.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("preprod_debug_env", SCRIPT)
pde = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pde)

from lib3mrai.envfile import MissingValue  # noqa: E402

PASSWORD = "s3cr3t-Pw-0123456789"
OUTPUTS = {
    "openobserve_root_password": PASSWORD,
    "api_gateway_url": "http://localhost:4566/restapis/abc/$default/_user_request_",
    "ws_url": "ws://localhost:4566/ws/xyz/dev",
}


def reader(outputs):
    def read(tf_dir, name):
        if name not in outputs:
            raise MissingValue(f"terraform output '{name}' is empty or failed")
        return outputs[name]
    return read


def run(tmp_path, outputs=OUTPUTS):
    return pde.main(["--tf-dir", str(tmp_path)], read_output=reader(outputs), root=tmp_path)


def parse(path):
    return dict(l.split("=", 1) for l in path.read_text().splitlines() if l and not l.startswith("#"))


def test_writes_exact_keys_and_values(tmp_path):
    assert run(tmp_path) == 0
    assert parse(tmp_path / ".env.preprod.debug") == {
        "WEB_URL": "http://localhost:9090",
        "OPENOBSERVE_URL": "http://localhost:5080",
        "OPENOBSERVE_USER": "admin@3mrai.local",
        "OPENOBSERVE_PASSWORD": PASSWORD,
        "MAILPIT_URL": "http://localhost:8025",
        "USERS_URL": "http://localhost:9101",
        "ORDERS_URL": "http://localhost:9102",
        "TRACKING_URL": "http://localhost:9103",
        "API_GATEWAY_URL": OUTPUTS["api_gateway_url"],
        "WS_URL": OUTPUTS["ws_url"],
    }


def test_file_is_private(tmp_path):
    run(tmp_path)
    assert stat.S_IMODE((tmp_path / ".env.preprod.debug").stat().st_mode) == 0o600


def test_header_says_no_database_urls(tmp_path):
    run(tmp_path)
    assert "database" in (tmp_path / ".env.preprod.debug").read_text().splitlines()[0].lower()


def test_custom_box_survives_regeneration(tmp_path):
    run(tmp_path)
    path = tmp_path / ".env.preprod.debug"
    path.write_text(path.read_text().replace("# <<< END CUSTOM", "MY_NOTE=keep\n# <<< END CUSTOM"))
    run(tmp_path)
    assert "MY_NOTE=keep" in path.read_text()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_missing_output_exits_1_and_writes_nothing(tmp_path, capsys):
    partial = {k: v for k, v in OUTPUTS.items() if k != "ws_url"}
    assert run(tmp_path, partial) == 1
    assert not (tmp_path / ".env.preprod.debug").exists()
    assert "make preprod-up" in capsys.readouterr().err


def test_output_never_contains_the_password(tmp_path, capsys):
    run(tmp_path)
    run(tmp_path, {k: v for k, v in OUTPUTS.items() if k != "ws_url"})
    captured = capsys.readouterr()
    assert PASSWORD not in captured.out + captured.err
