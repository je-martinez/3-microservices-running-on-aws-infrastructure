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


import json
import stat

import pytest

SECRETS = ["rk_test_USERSSECRET", "rk_test_ORDERSSECRET", "pk_test_PUBLISHABLE", "GEOSECRET", "whsec_WEBHOOKSECRET"]


def _run(tmp_path, **overrides):
    calls = {"ask": [], "secret": []}
    answers = iter(overrides.pop("answers", []))
    secret_answers = iter(overrides.pop("secret_answers", []))

    def ask(prompt):
        calls["ask"].append(prompt)
        return next(answers)

    def ask_secret(prompt):
        calls["secret"].append(prompt)
        return next(secret_answers)

    kwargs = dict(
        env_file=tmp_path / ".env.preprod",
        tfvars_path=tmp_path / "integrations.auto.tfvars.json",
        regenerate=True, prompt_allowed=True, stripe_off=False, geoapify_off=False,
        isatty=lambda: False, ask=ask, ask_secret=ask_secret,
        print_secret=lambda child_env: "whsec_WEBHOOKSECRET", which=lambda name: "/usr/bin/stripe",
        cidrs=lambda: "1.2.3.4",
    )
    kwargs.update(overrides)
    return pi.run(**kwargs), calls


def _write_custom(tmp_path, **values):
    _run(tmp_path)  # creates the skeleton (aborts: undecided)
    for key, value in values.items():
        pi.set_custom_value(tmp_path / ".env.preprod", key, value)


def test_missing_file_without_tty_creates_private_skeleton_and_aborts(tmp_path):
    rc, _ = _run(tmp_path)
    f = tmp_path / ".env.preprod"
    assert rc == 1 and f.exists()
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert "STRIPE_ENABLED=" in f.read_text() and pi.CUSTOM_BEGIN in f.read_text()
    assert not (tmp_path / "integrations.auto.tfvars.json").exists()


def test_off_flags_decide_without_asking(tmp_path):
    rc, calls = _run(tmp_path, stripe_off=True, geoapify_off=True)
    assert rc == 0 and calls["ask"] == []
    tv = json.loads((tmp_path / "integrations.auto.tfvars.json").read_text())
    assert tv["stripe_enabled"] is False and tv["geoapify_api_key"] == "disabled"


def test_tty_prompt_writes_choices_and_keys(tmp_path):
    rc, calls = _run(tmp_path, isatty=lambda: True,
                     answers=["y", "pk_test_PUBLISHABLE", "y"],
                     secret_answers=["rk_test_USERSSECRET", "rk_test_ORDERSSECRET", "GEOSECRET"])
    env = pi.parse(tmp_path / ".env.preprod")
    assert rc == 0
    assert env["STRIPE_ENABLED"] == "true" and env["STRIPE_SECRET_KEY_ORDERS"] == "rk_test_ORDERSSECRET"
    assert env["STRIPE_WEBHOOK_SECRET"] == "whsec_WEBHOOKSECRET"
    assert env["STRIPE_WEBHOOK_URL_TOKEN_USERS"] and env["STRIPE_WEBHOOK_URL_TOKEN_ORDERS"]
    assert env["STRIPE_WEBHOOK_URL_TOKEN_USERS"] != env["STRIPE_WEBHOOK_URL_TOKEN_ORDERS"]
    assert len(calls["secret"]) == 3


def test_no_prompt_flag_aborts_even_with_a_tty(tmp_path):
    rc, calls = _run(tmp_path, isatty=lambda: True, prompt_allowed=False)
    assert rc == 1 and calls["ask"] == []


def test_interrupted_prompt_writes_nothing(tmp_path):
    def boom(prompt):
        raise KeyboardInterrupt
    _run(tmp_path)  # skeleton
    before = (tmp_path / ".env.preprod").read_text()
    with pytest.raises(KeyboardInterrupt):
        _run(tmp_path, isatty=lambda: True, answers=["y"], ask_secret=boom)
    assert (tmp_path / ".env.preprod").read_text() == before


def test_enabled_with_missing_key_aborts_before_tfvars(tmp_path):
    _write_custom(tmp_path, STRIPE_ENABLED="true", GEOAPIFY_ENABLED="false")
    rc, _ = _run(tmp_path)
    assert rc == 1 and not (tmp_path / "integrations.auto.tfvars.json").exists()


def test_stripe_on_without_cli_aborts_before_tfvars(tmp_path):
    _write_custom(tmp_path, STRIPE_ENABLED="true", GEOAPIFY_ENABLED="false",
                  STRIPE_SECRET_KEY_USERS="rk_test_a", STRIPE_SECRET_KEY_ORDERS="rk_test_b",
                  STRIPE_PUBLISHABLE_KEY="pk_test_c")
    rc, _ = _run(tmp_path, which=lambda name: None)
    assert rc == 1 and not (tmp_path / "integrations.auto.tfvars.json").exists()


def _stripe_ready(tmp_path):
    _write_custom(tmp_path, STRIPE_ENABLED="true", GEOAPIFY_ENABLED="false",
                  STRIPE_SECRET_KEY_USERS="rk_test_a", STRIPE_SECRET_KEY_ORDERS="rk_test_b",
                  STRIPE_PUBLISHABLE_KEY="pk_test_c")


def test_no_prompt_preserves_auto_values(tmp_path):
    _stripe_ready(tmp_path)
    assert _run(tmp_path)[0] == 0
    first = pi.parse(tmp_path / ".env.preprod")
    assert _run(tmp_path, regenerate=False, prompt_allowed=False)[0] == 0
    second = pi.parse(tmp_path / ".env.preprod")
    for key in pi.AUTO_KEYS:
        assert first[key] == second[key]


def test_regenerate_rotates_url_tokens(tmp_path):
    _stripe_ready(tmp_path)
    _run(tmp_path)
    first = pi.parse(tmp_path / ".env.preprod")["STRIPE_WEBHOOK_URL_TOKEN_USERS"]
    _run(tmp_path)
    assert pi.parse(tmp_path / ".env.preprod")["STRIPE_WEBHOOK_URL_TOKEN_USERS"] != first


def test_no_prompt_without_auto_values_asks_for_preprod_up(tmp_path, capsys):
    _stripe_ready(tmp_path)
    rc, _ = _run(tmp_path, regenerate=False, prompt_allowed=False)
    assert rc == 1 and "make preprod-up" in capsys.readouterr().err


def test_custom_box_survives_regeneration(tmp_path):
    _stripe_ready(tmp_path)
    pi.set_custom_value(tmp_path / ".env.preprod", "MY_NOTE", "kept")
    _run(tmp_path)
    assert pi.parse(tmp_path / ".env.preprod")["MY_NOTE"] == "kept"


def test_tfvars_file_is_private(tmp_path):
    _run(tmp_path, stripe_off=True, geoapify_off=True)
    assert stat.S_IMODE((tmp_path / "integrations.auto.tfvars.json").stat().st_mode) == 0o600


def test_no_output_contains_a_key_value(tmp_path, capsys):
    _run(tmp_path, isatty=lambda: True,
         answers=["y", "pk_test_PUBLISHABLE", "y"],
         secret_answers=["rk_test_USERSSECRET", "rk_test_ORDERSSECRET", "GEOSECRET"])
    _run(tmp_path, regenerate=False, prompt_allowed=False)
    out = capsys.readouterr()
    for secret in SECRETS:
        assert secret not in out.out and secret not in out.err
