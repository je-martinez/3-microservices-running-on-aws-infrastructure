"""Tests for preprod_targets.py — ALB targets left behind by stopped ECS tasks."""

import importlib.util
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_targets.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("preprod_targets", SCRIPT)
pt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pt)


def _desc(ip, state="initial"):
    return {"Target": {"Id": ip, "Port": 3000}, "TargetHealth": {"State": state}}


def test_stale_targets_are_those_off_the_live_tasks():
    descs = [_desc("10.0.0.9", "unhealthy"), _desc("10.0.0.29"), _desc("10.0.0.40", "healthy")]
    assert pt.stale_targets(descs, {"10.0.0.29"}) == [{"Id": "10.0.0.9", "Port": 3000}, {"Id": "10.0.0.40", "Port": 3000}]


def test_stale_targets_flags_initial_too():
    assert pt.stale_targets([_desc("10.0.0.9")], {"10.0.0.29"}) == [{"Id": "10.0.0.9", "Port": 3000}]


def test_no_live_ip_means_nothing_is_judged_stale():
    assert pt.stale_targets([_desc("10.0.0.9")], set()) == []


def test_task_ip_reads_the_stack_network():
    nets = {"other": {"IPAddress": "172.0.0.2"}, "pp": {"IPAddress": "10.0.0.29"}}
    assert pt.task_ip(nets, "pp") == "10.0.0.29"
    assert pt.task_ip(nets, "missing") is None


A, B = "a" * 32, "b" * 32
TG = "arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/x-orders-http/1"


class FakeEcs:
    def __init__(self, statuses=None, failures=()):
        self.statuses = statuses or {A: "RUNNING", B: "RUNNING"}
        self.failures = list(failures)

    def list_tasks(self, **_):
        return {"taskArns": [f"arn:task/{t}" for t in self.statuses]}

    def describe_tasks(self, tasks, **_):
        found = [{"taskArn": a, "lastStatus": self.statuses[a.rsplit("/", 1)[-1]]} for a in tasks]
        return {"tasks": found, "failures": [{"arn": f"arn:task/{f}"} for f in self.failures]}

    def list_services(self, **_):
        return {"serviceArns": ["arn:svc/orders"]}

    def describe_services(self, **_):
        return {"services": [{"serviceName": "orders",
                              "loadBalancers": [{"targetGroupArn": TG, "containerName": "orders"}]}]}


class FakeElb:
    def __init__(self):
        self.deregistered = []

    def describe_target_groups(self):
        return {"TargetGroups": [{"TargetGroupArn": TG}]}

    def describe_target_health(self, **_):
        return {"TargetHealthDescriptions": [_desc("10.0.0.1"), _desc("10.0.0.2")]}

    def deregister_targets(self, **kwargs):
        self.deregistered.append(kwargs)


def _only_a_resolves(*args):
    nets = '{"pp": {"IPAddress": "10.0.0.1"}}' if args[1].endswith(f"{A}-orders") else ""
    return subprocess.CompletedProcess(args, 0 if nets else 1, stdout=nets, stderr="")


def test_live_ips_refuses_when_a_running_task_does_not_resolve():
    assert pt.live_ips(FakeEcs(), "c", "orders", "orders", "pp", _only_a_resolves) is None


def _run_main(monkeypatch, *flags):
    elb = FakeElb()
    monkeypatch.setattr(pt, "client", lambda name: FakeEcs() if name == "ecs" else elb)
    rc = pt.main(["--cluster", "c", "--network", "pp", *flags], run=_only_a_resolves)
    return rc, elb


def test_partial_resolution_deregisters_nothing(monkeypatch):
    rc, elb = _run_main(monkeypatch)
    assert elb.deregistered == []
    assert rc == 0


def test_partial_resolution_fails_the_check(monkeypatch):
    rc, elb = _run_main(monkeypatch, "--check")
    assert elb.deregistered == []
    assert rc == 1


def _both_resolve(*args):
    ip = "10.0.0.1" if args[1].endswith(f"{A}-orders") else "10.0.0.2"
    return subprocess.CompletedProcess(args, 0, stdout=f'{{"pp": {{"IPAddress": "{ip}"}}}}', stderr="")


def test_live_ips_skips_stopped_tasks():
    ecs = FakeEcs({A: "RUNNING", B: "STOPPED"})
    assert pt.live_ips(ecs, "c", "orders", "orders", "pp", _only_a_resolves) == {"10.0.0.1"}


def test_live_ips_counts_pending_tasks():
    ecs = FakeEcs({A: "RUNNING", B: "PENDING"})
    assert pt.live_ips(ecs, "c", "orders", "orders", "pp", _both_resolve) == {"10.0.0.1", "10.0.0.2"}


def test_pending_task_without_ip_refuses_to_judge():
    ecs = FakeEcs({A: "RUNNING", B: "PENDING"})
    assert pt.live_ips(ecs, "c", "orders", "orders", "pp", _only_a_resolves) is None


def test_describe_failure_refuses_to_judge():
    ecs = FakeEcs({A: "RUNNING"}, failures=[B])
    assert pt.live_ips(ecs, "c", "orders", "orders", "pp", _both_resolve) is None
