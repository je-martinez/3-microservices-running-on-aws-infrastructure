# infra/

Terraform infrastructure for 3MRAI. AWS resources use custom modules named with
the cloudposse/label convention. Local development runs on Ministack.

- `modules/` — own reusable modules (label, networking, database, messaging, compute, api-gateway).
- `environments/` — `local` (Ministack) and `production` (AWS) compositions.

See `CLAUDE.md` for stack, commands, and conventions.
