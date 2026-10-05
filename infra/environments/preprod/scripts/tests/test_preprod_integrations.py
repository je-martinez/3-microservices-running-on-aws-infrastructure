"""Tests for preprod_integrations.py — pure helpers."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_integrations.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("preprod_integrations", SCRIPT)
pi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pi)

ON = {
    "STRIPE_ENABLED": "true",
    "STRIPE_SECRET_KEY_USERS": "rk_test_users",
    "STRIPE_SECRET_KEY_ORDERS": "rk_test_orders",
    "STRIPE_PUBLISHABLE_KEY": "pk_test_pub",
    "GEOAPIFY_ENABLED": "true",
    "GEOAPIFY_API_KEY": "geo_key",
}
AUTO = {
    "STRIPE_WEBHOOK_SECRET": "whsec_abc",
    "STRIPE_WEBHOOK_URL_TOKEN_USERS": "tok_u",
    "STRIPE_WEBHOOK_URL_TOKEN_ORDERS": "tok_o",
}


def test_parse_reads_both_boxes_and_skips_comments(tmp_path):
    f = tmp_path / ".env.preprod"
    f.write_text("# h\n# >>> AUTO\nA=1\n# <<< END\n\n# >>> CUSTOM\n# B=commented\nC=3\n# <<< END CUSTOM\n")
    assert pi.parse(f) == {"A": "1", "C": "3"}


def test_parse_strips_matching_quotes(tmp_path):
    f = tmp_path / ".env.preprod"
    f.write_text("A=\"rk_test_x\"\nB='pk_test_y'\nC=\"unbalanced\n")
    assert pi.parse(f) == {"A": "rk_test_x", "B": "pk_test_y", "C": "\"unbalanced"}


def test_parse_missing_file_is_empty(tmp_path):
    assert pi.parse(tmp_path / "nope") == {}


def test_undecided_lists_flags_not_true_or_false():
    assert pi.undecided({}) == ["STRIPE_ENABLED", "GEOAPIFY_ENABLED"]
    assert pi.undecided({"STRIPE_ENABLED": "yes", "GEOAPIFY_ENABLED": "false"}) == ["STRIPE_ENABLED"]
    assert pi.undecided(ON) == []


def test_enabled_with_missing_key_names_it():
    env = {**ON, "STRIPE_SECRET_KEY_ORDERS": ""}
    assert any("STRIPE_SECRET_KEY_ORDERS" in p for p in pi.problems(env))
    env = {**ON, "GEOAPIFY_API_KEY": ""}
    assert any("GEOAPIFY_API_KEY" in p for p in pi.problems(env))


def test_live_keys_are_refused():
    for key, value in [("STRIPE_SECRET_KEY_USERS", "sk_live_x"), ("STRIPE_PUBLISHABLE_KEY", "pk_live_x"),
                       ("STRIPE_CLI_API_KEY", "rk_live_x")]:
        problems = pi.problems({**ON, key: value})
        assert any(key in p and "LIVE" in p for p in problems), key


def test_wrong_prefix_is_refused():
    assert any("STRIPE_SECRET_KEY_USERS" in p for p in pi.problems({**ON, "STRIPE_SECRET_KEY_USERS": "pk_test_x"}))
    assert any("STRIPE_PUBLISHABLE_KEY" in p for p in pi.problems({**ON, "STRIPE_PUBLISHABLE_KEY": "rk_test_x"}))


def test_problems_never_echo_a_value():
    env = {**ON, "STRIPE_SECRET_KEY_USERS": "sk_live_SECRETVALUE"}
    assert all("SECRETVALUE" not in p for p in pi.problems(env))


def test_valid_config_has_no_problems():
    assert pi.problems(ON) == []
    assert pi.problems({"STRIPE_ENABLED": "false", "GEOAPIFY_ENABLED": "false"}) == []


def test_cli_uses_the_login_session_unless_a_cli_key_is_set():
    assert pi.cli_api_key(ON) == ""
    assert "STRIPE_API_KEY" not in pi.cli_env(ON, base={})
    assert pi.cli_env({**ON, "STRIPE_CLI_API_KEY": "sk_test_cli"}, base={})["STRIPE_API_KEY"] == "sk_test_cli"
    assert pi.cli_env(ON, base={"PATH": "/bin"}) == {"PATH": "/bin"}


def test_tfvars_when_on():
    tv = pi.tfvars(ON, AUTO, "1.2.3.4,10.0.0.0/8")
    assert tv["stripe_enabled"] is True and tv["geoapify_enabled"] is True
    assert tv["stripe_secret_key_users"] == "rk_test_users"
    assert tv["stripe_secret_key_orders"] == "rk_test_orders"
    assert tv["stripe_webhook_secret"] == "whsec_abc"
    assert tv["stripe_webhook_url_token_users"] == "tok_u"
    assert tv["stripe_webhook_url_token_orders"] == "tok_o"
    assert tv["stripe_webhook_allowed_cidrs"] == "1.2.3.4,10.0.0.0/8"
    assert tv["geoapify_api_key"] == "geo_key"


def test_tfvars_when_off_carries_no_secret_and_the_geoapify_placeholder():
    env = {**ON, "STRIPE_ENABLED": "false", "GEOAPIFY_ENABLED": "false"}
    tv = pi.tfvars(env, {}, "")
    assert tv["stripe_enabled"] is False and tv["geoapify_enabled"] is False
    assert tv["stripe_secret_key_users"] == "" and tv["stripe_secret_key_orders"] == ""
    assert tv["geoapify_api_key"] == "disabled"


def test_summary_says_on_off_only():
    assert pi.summary(ON) == "Stripe: on · Geoapify: on"
    assert pi.summary({}) == "Stripe: off · Geoapify: off"
