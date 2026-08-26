"""Tests for lib3mrai.envfile's CUSTOM-box handling.

The AUTO box is rewritten wholesale on every run and needs no defending. The
CUSTOM box does: it is the one part of a generated env file a developer edits by
hand, and the rule "never overwrite what the developer changed" is the whole
reason the two-box format exists.

These cover the per-key seeding behaviour specifically, because the earlier
all-or-nothing version had a silent failure mode: a NEW default added to a
service whose CUSTOM box already had content was skipped for every existing
checkout, and only a fresh clone ever saw it (JE-195).
"""

from pathlib import Path

from lib3mrai.envfile import read_custom_block, write_env_file

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
