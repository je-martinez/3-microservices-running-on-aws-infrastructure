from lib3mrai import db


def test_default_network_is_dev(monkeypatch):
    monkeypatch.delenv("FLOCI_NETWORK", raising=False)
    assert db.compose_network() == "3mrai_3mrai-network"


def test_network_from_env(monkeypatch):
    monkeypatch.setenv("FLOCI_NETWORK", "3mrai-preprod_preprod-network")
    assert db.compose_network() == "3mrai-preprod_preprod-network"
    assert "3mrai-preprod_preprod-network" in db._probe_command("postgres", "floci", 7001)
