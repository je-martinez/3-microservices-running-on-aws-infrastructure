# infra/

Terraform infrastructure for 3MRAI. AWS resources use custom modules named with
the cloudposse/label convention. Local development runs on **Floci** (ADR-0017,
supersedes Ministack) — `make bootstrap` from the repo root is the entry point.

- `modules/` — own reusable modules: `label`, `networking`, `compute` (nginx on ECS),
  `api-gateway`, `cognito` (user pool + app client + the Pre-Token-Generation V2
  Lambda), `rds-aurora`. (`database/` and `messaging/` are empty placeholders.)
- `environments/` — `local` (Floci) and `production` (AWS) compositions.

See `CLAUDE.md` for stack, commands, and conventions.
