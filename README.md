# 3 Microservices Running on AWS Infrastructure (3MRAI)

Project knowledge base. The documentation lives in the Obsidian vault at [`docs/`](docs/).

## Start here
- [`docs/00-overview/index.md`](docs/00-overview/index.md) — root map of content
- [`docs/00-overview/architecture.md`](docs/00-overview/architecture.md) — global architecture
- [`docs/shared/decisions/`](docs/shared/decisions/) — architecture decision records (ADRs)

## Layout

The vault uses a hybrid **domain + type** layout: code organized by service (domain), cross-cutting knowledge organized by note type. Cross-cutting rules are defined once in `shared/` and referenced from service specs by `[[wikilink]]` — never duplicated.

- `docs/00-overview/` — root MOC (`index.md`), `architecture.md`, `system-context.md`, `glossary.md`
- `docs/domains/` — one folder per service: `users`, `orders`, `tracking`, `events-pipeline` (each has `specs/`, `decisions/`, `runbooks/`, `testing/`)
- `docs/infrastructure/` — Terraform, networking, AWS resources (`specs/`, `decisions/`, `runbooks/`)
- `docs/shared/` — cross-cutting `conventions/`, `patterns/`, `observability/`, and all global ADRs in `decisions/`
- `docs/templates/` — note templates
- `docs/lessons/`, `docs/retros/`, `docs/ideas/`, `docs/plans/` — root note types (`plans/archive/` for finished plans)
- `docs/superpowers/` — design specs (`specs/`) & implementation plans (`plans/`) for this project

## Local development

Run `make help` for the local dev commands. In short: `make up` starts the stack
(Floci + services), `make bootstrap` also applies the local Terraform against Floci,
and each service ships a `.http` file (e.g. `services/users/users.http`) you can run
with the VS Code REST Client extension. Full convention:
`docs/shared/conventions/local-dev.md`.

## Conventions
- Every note carries YAML frontmatter (`title`, `type`, `area`, `status`, `created`, `updated`, `tags`, and `related` where applicable) and ends with a `## Related` section of outgoing wikilinks.
- Tags are folder-style: `area/<x>`, `type/<x>`, `status/<x>`.
- Filenames: evergreen notes `kebab-case.md`; ADRs `ADR-NNNN-title-kebab.md`; dated notes `YYYY-MM-DD-short-title.md`.

## Validate
This repo pins Node via [`.nvmrc`](.nvmrc) — run `nvm use` first.

```bash
nvm use && node scripts/validate-vault.mjs
```

The validator checks that every note under `docs/` (excluding `.obsidian/` and `superpowers/`) has the required frontmatter keys and that every `[[wikilink]]` resolves to an existing note. It exits `0` on success, `1` with a list of offenders otherwise.

Source comments have their own gate:

```bash
make lint-comments        # whole repo
make install-comment-hook # once per clone — blocks commits that add violations
```

`.git/hooks` is not version-controlled, so the hook lives in `.githooks/` and the target installs it. Run it after cloning, or the gate stays inert. Full convention: [`docs/shared/conventions/code-comments.md`](docs/shared/conventions/code-comments.md).
