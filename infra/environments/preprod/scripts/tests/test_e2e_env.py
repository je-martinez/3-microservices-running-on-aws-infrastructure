import base64
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "e2e_env.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("e2e_env", SCRIPT)
ee = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ee)

OUTPUTS = {
    "api_gateway_url": "http://localhost:4566/restapis/abc/$default/_user_request_",
    "internal_api_key": "k", "carrier_api_key": "c", "e2e_query_token": "t",
    "events_query_url": "http://q", "ws_url": "ws://w",
    "notifications_queue_url": "http://n", "events_topic_arn": "arn:t",
    "openobserve_root_password": "p",
}


def test_env_from_outputs_keeps_literal_default():
    env = ee.env_from_outputs(OUTPUTS)
    assert env["API_GATEWAY_URL"].endswith("/$default/_user_request_")
    assert env["USERS_BASE_URL"] == "http://localhost:9101"
    assert env["ORDERS_BASE_URL"] == "http://localhost:9102"
    assert env["TRACKING_BASE_URL"] == "http://localhost:9103"
    assert env["MAILPIT_API_URL"] == "http://localhost:8025/api/v1"
    assert env["WEB_BASE_URL"] == "http://localhost:9090"
    assert env["TRACKING_CARRIER_API_KEY"] == "c"


def test_openobserve_auth_header_uses_pre_prod_password():
    env = ee.env_from_outputs(OUTPUTS)
    assert env["OPENOBSERVE_ORG"] == "3mrai"
    token = env["OPENOBSERVE_AUTH"].removeprefix("Basic ")
    assert base64.b64decode(token).decode() == "admin@3mrai.local:p"
