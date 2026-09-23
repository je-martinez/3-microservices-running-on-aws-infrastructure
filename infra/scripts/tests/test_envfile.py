"""Tests for lib3mrai.envfile's CUSTOM-box handling.

CONTRACT: These guard per-key seeding. All-or-nothing seeding silently skips a
newly added default for every checkout whose CUSTOM box already has content,
and only a fresh clone ever sees it. See [[env-files]]
"""

from pathlib import Path

import pytest

from lib3mrai.envfile import (
    MissingCustomBox,
    read_custom_block,
    set_custom_value,
    write_env_file,
)

HEADER = "Test service environment."
GENERATED = {"DATABASE_URL": "postgres://x"}


def _write(path: Path, custom_defaults: dict[str, str] | None = None) -> None:
    write_env_file(
        path,
        header=HEADER,
        generated=GENERATED,
        custom_defaults=custom_defaults,
    )


class TestFirstRun:
    def test_seeds_every_default_when_the_file_does_not_exist(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"

        _write(target, {"PORT": "3000", "CACHE_ENABLED": "true"})

        custom = read_custom_block(target)
        assert "PORT=3000" in custom
        assert "CACHE_ENABLED=true" in custom

    def test_writes_no_custom_entries_when_there_are_no_defaults(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"

        _write(target)

        assert read_custom_block(target) == []


class TestPreservingDeveloperEdits:
    def test_an_edited_value_survives_regeneration(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"PORT": "3000"})
        target.write_text(target.read_text().replace("PORT=3000", "PORT=9999"))

        _write(target, {"PORT": "3000"})

        assert "PORT=9999" in read_custom_block(target)
        assert "PORT=3000" not in read_custom_block(target)

    def test_a_key_the_developer_commented_out_is_not_re_seeded(self, tmp_path: Path) -> None:
        # Commenting a line out is a deliberate act. Re-adding the key would
        # silently undo it, and the developer would have no way to keep it off.
        target = tmp_path / ".env.local.svc"
        _write(target, {"CACHE_ENABLED": "true"})
        target.write_text(
            target.read_text().replace("CACHE_ENABLED=true", "# CACHE_ENABLED=true")
        )

        _write(target, {"CACHE_ENABLED": "true"})

        custom = read_custom_block(target)
        assert "# CACHE_ENABLED=true" in custom
        assert "CACHE_ENABLED=true" not in custom

    def test_an_unrelated_custom_line_is_untouched(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"PORT": "3000"})
        target.write_text(
            target.read_text().replace("PORT=3000", "PORT=3000\nMY_TOKEN=hunter2")
        )

        _write(target, {"PORT": "3000"})

        assert "MY_TOKEN=hunter2" in read_custom_block(target)


class TestSeedingANewDefaultIntoAnExistingBox:
    """The JE-195 regression: this is what the all-or-nothing version missed."""

    def test_a_new_default_is_added_to_a_box_that_already_has_content(
        self, tmp_path: Path
    ) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"PORT": "3000"})
        assert "CACHE_ENABLED=true" not in read_custom_block(target)

        # A later release adds a new default alongside the existing one.
        _write(target, {"PORT": "3000", "CACHE_ENABLED": "true"})

        custom = read_custom_block(target)
        assert "CACHE_ENABLED=true" in custom
        assert "PORT=3000" in custom

    def test_seeding_a_new_default_does_not_disturb_an_edited_sibling(
        self, tmp_path: Path
    ) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"PORT": "3000"})
        target.write_text(target.read_text().replace("PORT=3000", "PORT=9999"))

        _write(target, {"PORT": "3000", "CACHE_ENABLED": "true"})

        custom = read_custom_block(target)
        assert "PORT=9999" in custom
        assert "CACHE_ENABLED=true" in custom


class TestAutoBox:
    def test_the_auto_box_is_rewritten_from_the_generated_mapping(
        self, tmp_path: Path
    ) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target)

        write_env_file(
            target,
            header=HEADER,
            generated={"DATABASE_URL": "postgres://changed"},
        )

        assert "DATABASE_URL=postgres://changed" in target.read_text()
        assert "postgres://x" not in target.read_text()


class TestSetCustomValue:
    def test_replaces_an_empty_seeded_value(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"STRIPE_WEBHOOK_SECRET": ""})

        set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_abc123")

        assert "STRIPE_WEBHOOK_SECRET=whsec_abc123" in read_custom_block(target)

    def test_replaces_an_existing_value(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"STRIPE_WEBHOOK_SECRET": "whsec_old"})

        set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")

        custom = read_custom_block(target)
        assert "STRIPE_WEBHOOK_SECRET=whsec_new" in custom
        assert "STRIPE_WEBHOOK_SECRET=whsec_old" not in custom

    def test_appends_when_the_key_is_missing(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"PORT": "3000"})

        set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")

        custom = read_custom_block(target)
        assert "STRIPE_WEBHOOK_SECRET=whsec_new" in custom
        assert "PORT=3000" in custom

    def test_replaces_a_commented_out_line(self, tmp_path: Path) -> None:
        # Running this command is a deliberate act, so it overrides a prior
        # deliberate disable rather than leaving the comment untouched.
        target = tmp_path / ".env.local.svc"
        _write(target, {"STRIPE_WEBHOOK_SECRET": "whsec_old"})
        target.write_text(
            target.read_text().replace(
                "STRIPE_WEBHOOK_SECRET=whsec_old", "# STRIPE_WEBHOOK_SECRET=whsec_old"
            )
        )

        set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")

        custom = read_custom_block(target)
        assert "STRIPE_WEBHOOK_SECRET=whsec_new" in custom
        assert "# STRIPE_WEBHOOK_SECRET=whsec_old" not in custom

    def test_the_auto_box_is_untouched(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        write_env_file(
            target,
            header=HEADER,
            generated={"STRIPE_WEBHOOK_SECRET": "auto-value-must-survive"},
            custom_defaults={"STRIPE_WEBHOOK_SECRET": ""},
        )

        set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")

        text = target.read_text()
        assert "STRIPE_WEBHOOK_SECRET=auto-value-must-survive" in text
        assert "STRIPE_WEBHOOK_SECRET=whsec_new" in read_custom_block(target)

    def test_other_custom_lines_are_untouched(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        _write(target, {"PORT": "3000", "STRIPE_WEBHOOK_SECRET": ""})

        set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")

        assert "PORT=3000" in read_custom_block(target)

    def test_missing_file_raises_a_clear_error(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"

        with pytest.raises(MissingCustomBox, match="make env-file"):
            set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")

    def test_missing_custom_markers_raises_a_clear_error(self, tmp_path: Path) -> None:
        target = tmp_path / ".env.local.svc"
        target.write_text("PORT=3000\n")

        with pytest.raises(MissingCustomBox, match="make env-file"):
            set_custom_value(target, "STRIPE_WEBHOOK_SECRET", "whsec_new")
