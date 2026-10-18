import pytest

from diagrams3mrai.catalog import Entry
from diagrams3mrai.drift import DriftResult, affected

ENTRIES = [
    Entry("arch", "Arch", "diagrams/src/architecture/arch.html", "docs/00-overview/diagrams/arch",
          ("infra/modules/**", "docker-compose.yml")),
    Entry("otp", "OTP", "diagrams/src/flows/otp.html", "docs/domains/users/specs/diagrams/otp",
          ("infra/modules/cognito/**", "services/users/src/**")),
]


def test_nothing_when_no_watched_path_changed():
    assert affected(["README.md"], ENTRIES) == []


def test_flags_every_matching_entry_as_stale():
    assert affected(["infra/modules/cognito/main.tf"], ENTRIES) == [
        DriftResult("arch", "stale", ("infra/modules/cognito/main.tf",)),
        DriftResult("otp", "stale", ("infra/modules/cognito/main.tf",)),
    ]


def test_updated_when_png_changed_alongside():
    assert affected(["docker-compose.yml", "docs/00-overview/diagrams/arch.png"], ENTRIES) == [
        DriftResult("arch", "updated", ("docker-compose.yml",)),
    ]


def test_render_only_diff_is_ignored():
    assert affected(["docs/00-overview/diagrams/arch.png"], ENTRIES) == []


def test_own_src_is_an_implicit_watch():
    assert affected(["diagrams/src/flows/otp.html"], ENTRIES) == [
        DriftResult("otp", "stale", ("diagrams/src/flows/otp.html",)),
    ]


@pytest.mark.parametrize("f", ["diagrams/diagrams3mrai/render.py", "diagrams/icons.yaml", "diagrams/pyproject.toml", ".diagram-design"])
def test_shared_render_change_flags_every_entry(f):
    assert [(r.id, r.status) for r in affected([f], ENTRIES)] == [("arch", "stale"), ("otp", "stale")]


@pytest.mark.parametrize("f", [
    "services/users/src/users/commands/register.command.test.ts",
    "services/users/src/users/register.spec.ts",
    "infra/modules/cognito/main_test.go",
    "services/users/src/test/helpers.ts",
    "services/users/src/tests/fixtures.ts",
    "services/users/src/__tests__/x.ts",
])
def test_test_files_never_flag(f):
    assert affected([f], ENTRIES) == []


def test_single_star_does_not_cross_directories():
    e = [Entry("c", "C", "diagrams/src/flows/c.html", "docs/x/c", ("services/*/src/shared/cache/**",))]
    assert [r.id for r in affected(["services/orders/src/shared/cache/a.ts"], e)] == ["c"]
    assert affected(["services/orders/extra/src/shared/cache/a.ts"], e) == []
