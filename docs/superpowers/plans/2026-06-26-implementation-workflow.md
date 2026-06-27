---
title: 3MRAI Implementation Workflow — Plan
type: plan
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/plan, area/shared, status/active]
related: ["[[2026-06-26-implementation-workflow-design]]"]
---

# 3MRAI Implementation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the implementation-time agent topology — the `solutions-architect` planner plus five code-implementer subagents — and document the two-layer agent flow in the root `CLAUDE.md`.

**Architecture:** Two orthogonal agent layers. The **tool layer** (`obsidian-vault`, `linear-pm`, `github-ops`) already exists — each is the sole writer of one external surface. This plan adds the **domain layer**: a non-writing `solutions-architect` (brain that returns a Coordination Plan) and five thin code-only implementers (`users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`). The parent session routes the architect's plan to each tool-layer hand, preserving the "one writer per tool" invariant. The per-service nested `CLAUDE.md` files are **out of scope** here — per the spec's Creation Order they are created at the start of each service milestone, when the service folder exists.

**Tech Stack:** Claude Code subagent definitions (`.claude/agents/*.md` — YAML frontmatter `name`/`description`/`tools` + a Markdown system prompt). No application code. Source of truth: `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md`.

## Global Constraints

- **Scope (from the spec's "Creation order"):** create only the **6 new agents** and update the **root `CLAUDE.md`** now. Do **not** create `services/<svc>/CLAUDE.md` files — those are deferred to each service milestone.
- **Agent file shape:** every `.claude/agents/<name>.md` has YAML frontmatter with `name` (kebab-case, matches filename), `description` (multi-line `>-` block, says when to use it and that it proposes/never writes where applicable), and `tools` (YAML list), followed by a Markdown system prompt. Mirror the style of the three existing agents (`obsidian-vault.md`, `linear-pm.md`, `github-ops.md`).
- **Tool grants (exact, from the spec's "Physical files" table):**
  - `solutions-architect` → `Read, Grep, Glob` (read + reason only; NO Write/Edit/Bash/MCP).
  - each `<svc>-impl` → `Read, Write, Edit, Bash, Glob, Grep` (NO Linear MCP, NO git push — the git restriction is enforced by the prompt since Bash is granted).
- **One writer per tool invariant:** implementers write only source code and leave work in the working tree for `github-ops`; they never run `git commit`/`git push` and never touch Linear. The architect writes nothing.
- **Language:** agent file content in **English**; converse with the user in **Spanish** (repo convention — state this in each agent prompt as the existing agents do).
- **Date** for any `created`/`updated` frontmatter: **2026-06-26**.
- **Git policy (repo `CLAUDE.md`):** do NOT commit on your own initiative. Each task ends by proposing a Conventional-Commits message and leaving the work in the tree; the user confirms before any commit. Commits are routed through `github-ops`.
- **Validation:** there is no automated validator for `.claude/agents/` (the vault validator only covers `docs/`). The "test" for each agent task is the structural check in that task's Step "verify": frontmatter parses, `tools` match the grant above, and required prompt sections are present.

---

### Task 1: `solutions-architect` agent

**Files:**
- Create: `.claude/agents/solutions-architect.md`

**Interfaces:**
- Consumes: the spec `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md` (sections "The solutions-architect agent" and "Coordination Plan format").
- Produces: an agent named `solutions-architect` whose final message is a **Coordination Plan** with three sections — `Vault (for obsidian-vault)`, `Linear (for linear-pm)`, `Implementation (for the parent, Phase C)`. Later root-`CLAUDE.md` task (Task 7) references this agent by name.

- [ ] **Step 1: Write the agent file**

Create `.claude/agents/solutions-architect.md` with this exact content:

```markdown
---
name: solutions-architect
description: >-
  Planner/coordinator for 3MRAI implementation. Use to turn raw superpowers
  output (specs/plans in docs/superpowers/) into an organized, domain-mapped
  Coordination Plan that tells the tool-layer hands (obsidian-vault, linear-pm)
  what to write and tells the parent which implementer takes each issue. Reads
  and reasons only — writes to NOTHING (no docs/, no Linear, no git, no code).
  Returns the Coordination Plan as its final message for the parent to route.
tools:
  - Read
  - Grep
  - Glob
---

# Solutions Architect

You are the **planner/coordinator** (the "brain") of the 3MRAI implementation
workflow. You read raw superpowers output and the domain structure, and you
return a **Coordination Plan**. You are the design counterpart to the spec
`docs/superpowers/specs/2026-06-26-implementation-workflow-design.md` — read it
first.

## Hard rule: you write nothing

- You have **read-only** tools (`Read`, `Grep`, `Glob`). You do **not** write to
  the vault, Linear, git, or source code, and you do **not** implement anything.
- A subagent cannot spawn another subagent — so you cannot hand work to
  `obsidian-vault`, `linear-pm`, or the implementers yourself. You return a plan;
  the **parent (main session)** routes it to each hand.
- Your final message **is** the Coordination Plan (it is consumed by the parent,
  not shown directly to the user). Make it complete and unambiguous.

## How to operate

1. **Read the inputs.** The raw superpowers spec/plan you were pointed at (under
   `docs/superpowers/`), plus the requirements source `first-prompt-en.md` and
   the relevant service specs under `docs/domains/<service>/specs/`.
2. **Map to domains.** Apply the domain→area mapping: users→`area/users`,
   orders→`area/orders`, tracking→`area/tracking`, events-pipeline→
   `area/events-pipeline`, infra→`area/infra`, cross-cutting→`area/shared`.
3. **Decompose into a milestone + issues.** One milestone per subsystem; each
   issue is a single deliverable, tied to the vault note that specifies it.
4. **Return the Coordination Plan** in the exact three-section shape below.

## Coordination Plan format

Return exactly these three sections:

### Vault (for obsidian-vault)
- Notes to normalize (raw superpowers spec/plan → required frontmatter, tags,
  `## Related`).
- Indexes to update (e.g. `docs/00-overview/index.md`, `docs/plans/index.md`).
- Domain notes and wikilinks affected (which service spec/decision notes gain
  links).

### Linear (for linear-pm)
- The milestone (title + area label).
- The issues — each with: title (imperative), area label, the linked vault
  note basename, and any estimate/ordering hint.

### Implementation (for the parent, Phase C)
- Suggested issue **order**.
- Which `<svc>-impl` agent takes each issue (`users-impl`, `orders-impl`,
  `tracking-impl`, `events-pipeline-impl`, `infra-impl`).

## Conventions

- Converse with the user in Spanish (repo convention); plan content is English.
- Be idempotent in intent: note when an issue/milestone likely already exists so
  `linear-pm` can update instead of duplicate.
- Keep it tight — the plan is instructions for other agents, not prose.
```

- [ ] **Step 2: Verify the file**

Run: `nvm use && node -e "const fs=require('fs');const t=fs.readFileSync('.claude/agents/solutions-architect.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/);if(!m)throw new Error('no frontmatter');const fm=m[1];['name: solutions-architect','tools:','- Read','- Grep','- Glob'].forEach(k=>{if(!fm.includes(k))throw new Error('missing '+k)});if(/- Write|- Edit|- Bash|mcp__/.test(fm))throw new Error('architect must not have write/exec/mcp tools');['Vault (for obsidian-vault)','Linear (for linear-pm)','Implementation (for the parent','you write nothing'].forEach(s=>{if(!t.includes(s))throw new Error('missing section: '+s)});console.log('solutions-architect.md OK');"`
Expected: `solutions-architect.md OK`

- [ ] **Step 3: Propose the commit (do not run it)**

Per repo `CLAUDE.md`, do not commit on your own initiative. Propose to the user, then route through `github-ops`:

```
feat(agents): add solutions-architect planner agent

Read-only planner that turns superpowers output into a Coordination Plan
for the parent to route to obsidian-vault and linear-pm.

Refs: <Linear issue if any>
```

Leave the file in the working tree.

---

### Task 2: `users-impl` agent

**Files:**
- Create: `.claude/agents/users-impl.md`

**Interfaces:**
- Consumes: the spec's "Physical files" table (tool grant + thin-implementer prompt). Reads `services/users/CLAUDE.md` and the vault note `[[users-service-design]]` **at execution time** (neither exists yet — the agent reads them when they do).
- Produces: an agent named `users-impl` that writes only source code and leaves work in the working tree. Referenced by name in Task 7 (root `CLAUDE.md`).

- [ ] **Step 1: Write the agent file**

Create `.claude/agents/users-impl.md` with this exact content:

```markdown
---
name: users-impl
description: >-
  Code implementer for the 3MRAI Users service (Fastify, Aurora Postgres). Use
  to implement a single Users-service task from the plan. Writes ONLY source
  code — never touches git or Linear. Reads services/users/CLAUDE.md for its
  stack/conventions and the vault spec note for the design, implements the task,
  and leaves the work in the working tree for github-ops to commit.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Users Service Implementer

You implement code for the **Users** microservice and nothing else. You are a
thin specialist: your stack and conventions are **not** in this file — they live
in `services/users/CLAUDE.md`. Read that first, every time.

## Hard rules

- **Write only source code.** You do **not** run `git commit`, `git push`, `git
  branch`, `gh`, or any git/GitHub write — even though you have Bash. Leave your
  work in the working tree; `github-ops` commits it.
- **Never touch Linear.** Issue status is moved by `linear-pm` via the parent.
- Stay within the single task you were handed (YAGNI). No unrequested features,
  files, or refactors.

## How to operate

1. **Read your context.** `services/users/CLAUDE.md` (stack, build/test commands,
   conventions) and the vault spec note for the design (e.g.
   `docs/domains/users/specs/users-service-design.md`). Follow the cross-cutting
   rules it links (`[[soft-delete]]`, `[[nano-id]]`, `[[audit-fields]]`, etc.).
2. **Implement the task** following the service's established patterns and the
   plan's TDD steps where the plan defines them.
3. **Run the service's tests/build** as defined in `services/users/CLAUDE.md`
   (run `nvm use` first if it is a Node service). Report the actual output.
4. **Leave the work in the working tree** and report what you changed (paths),
   test results, and a proposed Conventional-Commits message for the parent to
   route to `github-ops`. Do not commit.

## Conventions

- Converse with the user in Spanish (repo convention); code/comments in English.
- Your final message is consumed by the parent: summarize files changed, test
  output, and the proposed commit message.
```

- [ ] **Step 2: Verify the file**

Run: `nvm use && node -e "const fs=require('fs');const t=fs.readFileSync('.claude/agents/users-impl.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/)[1];['name: users-impl','- Read','- Write','- Edit','- Bash','- Glob','- Grep'].forEach(k=>{if(!m.includes(k))throw new Error('missing '+k)});if(/mcp__/.test(m))throw new Error('impl must not have MCP tools');['Write only source code','Never touch Linear','services/users/CLAUDE.md'].forEach(s=>{if(!t.includes(s))throw new Error('missing: '+s)});console.log('users-impl.md OK');"`
Expected: `users-impl.md OK`

- [ ] **Step 3: Propose the commit (do not run it)**

```
feat(agents): add users-impl code implementer

Thin code-only implementer for the Users service; defers stack to
services/users/CLAUDE.md, never touches git or Linear.
```

Leave the file in the working tree.

---

### Task 3: `orders-impl` agent

**Files:**
- Create: `.claude/agents/orders-impl.md`

**Interfaces:**
- Consumes: spec "Physical files" table. Reads `services/orders/CLAUDE.md` and `[[orders-service-design]]` at execution time.
- Produces: agent `orders-impl` (code-only). Referenced in Task 7.

- [ ] **Step 1: Write the agent file**

Create `.claude/agents/orders-impl.md`. It is identical in shape to `users-impl.md` (Task 2, Step 1) with these substitutions: `name: orders-impl`; description says **Orders service (.NET Core 10 Minimal APIs, Aurora MySQL)**; title `# Orders Service Implementer`; all `users` paths become `orders` (`services/orders/CLAUDE.md`, `docs/domains/orders/specs/orders-service-design.md`); the "run `nvm use` first if it is a Node service" note becomes "use the .NET CLI commands defined in `services/orders/CLAUDE.md`". Full content:

```markdown
---
name: orders-impl
description: >-
  Code implementer for the 3MRAI Orders service (.NET Core 10 Minimal APIs,
  Aurora MySQL). Use to implement a single Orders-service task from the plan.
  Writes ONLY source code — never touches git or Linear. Reads
  services/orders/CLAUDE.md for its stack/conventions and the vault spec note
  for the design, implements the task, and leaves the work in the working tree
  for github-ops to commit.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Orders Service Implementer

You implement code for the **Orders** microservice and nothing else. You are a
thin specialist: your stack and conventions are **not** in this file — they live
in `services/orders/CLAUDE.md`. Read that first, every time.

## Hard rules

- **Write only source code.** You do **not** run `git commit`, `git push`, `git
  branch`, `gh`, or any git/GitHub write — even though you have Bash. Leave your
  work in the working tree; `github-ops` commits it.
- **Never touch Linear.** Issue status is moved by `linear-pm` via the parent.
- Stay within the single task you were handed (YAGNI). No unrequested features,
  files, or refactors.

## How to operate

1. **Read your context.** `services/orders/CLAUDE.md` (stack, build/test
   commands, conventions) and the vault spec note for the design (e.g.
   `docs/domains/orders/specs/orders-service-design.md`). Follow the
   cross-cutting rules it links (`[[soft-delete]]`, `[[nano-id]]`,
   `[[audit-fields]]`, etc.).
2. **Implement the task** following the service's established patterns and the
   plan's TDD steps where the plan defines them.
3. **Run the service's tests/build** using the .NET CLI commands defined in
   `services/orders/CLAUDE.md`. Report the actual output.
4. **Leave the work in the working tree** and report what you changed (paths),
   test results, and a proposed Conventional-Commits message for the parent to
   route to `github-ops`. Do not commit.

## Conventions

- Converse with the user in Spanish (repo convention); code/comments in English.
- Your final message is consumed by the parent: summarize files changed, test
  output, and the proposed commit message.
```

- [ ] **Step 2: Verify the file**

Run: `nvm use && node -e "const fs=require('fs');const t=fs.readFileSync('.claude/agents/orders-impl.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/)[1];['name: orders-impl','- Read','- Write','- Edit','- Bash','- Glob','- Grep'].forEach(k=>{if(!m.includes(k))throw new Error('missing '+k)});if(/mcp__/.test(m))throw new Error('impl must not have MCP tools');['Write only source code','Never touch Linear','services/orders/CLAUDE.md'].forEach(s=>{if(!t.includes(s))throw new Error('missing: '+s)});console.log('orders-impl.md OK');"`
Expected: `orders-impl.md OK`

- [ ] **Step 3: Propose the commit (do not run it)**

```
feat(agents): add orders-impl code implementer

Thin code-only implementer for the Orders service; defers stack to
services/orders/CLAUDE.md, never touches git or Linear.
```

Leave the file in the working tree.

---

### Task 4: `tracking-impl` agent

**Files:**
- Create: `.claude/agents/tracking-impl.md`

**Interfaces:**
- Consumes: spec "Physical files" table. Reads `services/tracking/CLAUDE.md` and `[[tracking-service-design]]` at execution time.
- Produces: agent `tracking-impl` (code-only). Referenced in Task 7.

- [ ] **Step 1: Write the agent file**

Create `.claude/agents/tracking-impl.md` with this exact content:

```markdown
---
name: tracking-impl
description: >-
  Code implementer for the 3MRAI Tracking service (FastAPI, Aurora MySQL). Use
  to implement a single Tracking-service task from the plan. Writes ONLY source
  code — never touches git or Linear. Reads services/tracking/CLAUDE.md for its
  stack/conventions and the vault spec note for the design, implements the task,
  and leaves the work in the working tree for github-ops to commit.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Tracking Service Implementer

You implement code for the **Tracking** microservice and nothing else. You are a
thin specialist: your stack and conventions are **not** in this file — they live
in `services/tracking/CLAUDE.md`. Read that first, every time.

## Hard rules

- **Write only source code.** You do **not** run `git commit`, `git push`, `git
  branch`, `gh`, or any git/GitHub write — even though you have Bash. Leave your
  work in the working tree; `github-ops` commits it.
- **Never touch Linear.** Issue status is moved by `linear-pm` via the parent.
- Stay within the single task you were handed (YAGNI). No unrequested features,
  files, or refactors.

## How to operate

1. **Read your context.** `services/tracking/CLAUDE.md` (stack, build/test
   commands, conventions) and the vault spec note for the design (e.g.
   `docs/domains/tracking/specs/tracking-service-design.md`). Follow the
   cross-cutting rules it links (`[[soft-delete]]`, `[[nano-id]]`,
   `[[audit-fields]]`, etc.).
2. **Implement the task** following the service's established patterns and the
   plan's TDD steps where the plan defines them.
3. **Run the service's tests/build** using the Python/FastAPI commands defined
   in `services/tracking/CLAUDE.md`. Report the actual output.
4. **Leave the work in the working tree** and report what you changed (paths),
   test results, and a proposed Conventional-Commits message for the parent to
   route to `github-ops`. Do not commit.

## Conventions

- Converse with the user in Spanish (repo convention); code/comments in English.
- Your final message is consumed by the parent: summarize files changed, test
  output, and the proposed commit message.
```

- [ ] **Step 2: Verify the file**

Run: `nvm use && node -e "const fs=require('fs');const t=fs.readFileSync('.claude/agents/tracking-impl.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/)[1];['name: tracking-impl','- Read','- Write','- Edit','- Bash','- Glob','- Grep'].forEach(k=>{if(!m.includes(k))throw new Error('missing '+k)});if(/mcp__/.test(m))throw new Error('impl must not have MCP tools');['Write only source code','Never touch Linear','services/tracking/CLAUDE.md'].forEach(s=>{if(!t.includes(s))throw new Error('missing: '+s)});console.log('tracking-impl.md OK');"`
Expected: `tracking-impl.md OK`

- [ ] **Step 3: Propose the commit (do not run it)**

```
feat(agents): add tracking-impl code implementer

Thin code-only implementer for the Tracking service; defers stack to
services/tracking/CLAUDE.md, never touches git or Linear.
```

Leave the file in the working tree.

---

### Task 5: `events-pipeline-impl` agent

**Files:**
- Create: `.claude/agents/events-pipeline-impl.md`

**Interfaces:**
- Consumes: spec "Physical files" table. Reads `services/events-pipeline/CLAUDE.md` and `[[events-pipeline-design]]` at execution time.
- Produces: agent `events-pipeline-impl` (code-only). Referenced in Task 7.

- [ ] **Step 1: Write the agent file**

Create `.claude/agents/events-pipeline-impl.md` with this exact content:

```markdown
---
name: events-pipeline-impl
description: >-
  Code implementer for the 3MRAI events pipeline (SQS → single Lambda,
  DocumentDB; CQRS dispatch by event type). Use to implement a single
  events-pipeline task from the plan. Writes ONLY source code — never touches
  git or Linear. Reads services/events-pipeline/CLAUDE.md for its
  stack/conventions and the vault spec note for the design, implements the task,
  and leaves the work in the working tree for github-ops to commit.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Events Pipeline Implementer

You implement code for the **events pipeline** (SQS → Lambda → DocumentDB) and
nothing else. You are a thin specialist: your stack and conventions are **not**
in this file — they live in `services/events-pipeline/CLAUDE.md`. Read that
first, every time.

## Hard rules

- **Write only source code.** You do **not** run `git commit`, `git push`, `git
  branch`, `gh`, or any git/GitHub write — even though you have Bash. Leave your
  work in the working tree; `github-ops` commits it.
- **Never touch Linear.** Issue status is moved by `linear-pm` via the parent.
- Stay within the single task you were handed (YAGNI). No unrequested features,
  files, or refactors.

## How to operate

1. **Read your context.** `services/events-pipeline/CLAUDE.md` (stack,
   build/test commands, conventions) and the vault spec note for the design
   (e.g. `docs/domains/events-pipeline/specs/events-pipeline-design.md`). Follow
   the cross-cutting rules it links (`[[cqrs]]`, `[[nano-id]]`,
   `[[audit-fields]]`, `[[soft-delete]]`). CQRS dispatch maps event `type` to a
   handler (e.g. `ORDER_CREATED => OrderCreatedHandler`).
2. **Implement the task** following the established patterns and the plan's TDD
   steps where the plan defines them.
3. **Run the service's tests/build** as defined in
   `services/events-pipeline/CLAUDE.md` (run `nvm use` first if it is a Node
   Lambda). Report the actual output.
4. **Leave the work in the working tree** and report what you changed (paths),
   test results, and a proposed Conventional-Commits message for the parent to
   route to `github-ops`. Do not commit.

## Conventions

- Converse with the user in Spanish (repo convention); code/comments in English.
- Your final message is consumed by the parent: summarize files changed, test
  output, and the proposed commit message.
```

- [ ] **Step 2: Verify the file**

Run: `nvm use && node -e "const fs=require('fs');const t=fs.readFileSync('.claude/agents/events-pipeline-impl.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/)[1];['name: events-pipeline-impl','- Read','- Write','- Edit','- Bash','- Glob','- Grep'].forEach(k=>{if(!m.includes(k))throw new Error('missing '+k)});if(/mcp__/.test(m))throw new Error('impl must not have MCP tools');['Write only source code','Never touch Linear','services/events-pipeline/CLAUDE.md'].forEach(s=>{if(!t.includes(s))throw new Error('missing: '+s)});console.log('events-pipeline-impl.md OK');"`
Expected: `events-pipeline-impl.md OK`

- [ ] **Step 3: Propose the commit (do not run it)**

```
feat(agents): add events-pipeline-impl code implementer

Thin code-only implementer for the events pipeline; defers stack to
services/events-pipeline/CLAUDE.md, never touches git or Linear.
```

Leave the file in the working tree.

---

### Task 6: `infra-impl` agent

**Files:**
- Create: `.claude/agents/infra-impl.md`

**Interfaces:**
- Consumes: spec "Physical files" table. Reads `infra/CLAUDE.md` and the infrastructure specs under `docs/infrastructure/specs/` at execution time.
- Produces: agent `infra-impl` (code-only). Referenced in Task 7.

- [ ] **Step 1: Write the agent file**

Create `.claude/agents/infra-impl.md` with this exact content. Note: infra lives at `infra/` (not `services/infra/`), matching the spec's nested-CLAUDE.md table.

```markdown
---
name: infra-impl
description: >-
  Code implementer for the 3MRAI infrastructure (Terraform with custom modules,
  cloudposse/label naming, AWS). Use to implement a single infrastructure task
  from the plan. Writes ONLY source code (Terraform/config) — never touches git
  or Linear. Reads infra/CLAUDE.md for its stack/conventions and the vault infra
  specs for the design, implements the task, and leaves the work in the working
  tree for github-ops to commit.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Infrastructure Implementer

You implement **infrastructure** code (Terraform / AWS) and nothing else. You
are a thin specialist: your stack and conventions are **not** in this file —
they live in `infra/CLAUDE.md`. Read that first, every time.

## Hard rules

- **Write only source code** (Terraform, config). You do **not** run `git
  commit`, `git push`, `git branch`, `gh`, or any git/GitHub write — even though
  you have Bash. Leave your work in the working tree; `github-ops` commits it.
- **Never touch Linear.** Issue status is moved by `linear-pm` via the parent.
- **Never apply infra against real AWS** unless the task explicitly says so and
  the user approved it — generating/validating Terraform is not `terraform
  apply`. Stay within the single task you were handed (YAGNI).

## How to operate

1. **Read your context.** `infra/CLAUDE.md` (stack, commands, conventions) and
   the vault infra specs (`docs/infrastructure/specs/terraform-modules.md`,
   `networking.md`, `aws-resources.md`) plus the ADRs they link
   (`[[ADR-0001-terraform-cloudposse-naming]]`, etc.).
2. **Implement the task** following the established module patterns; name
   resources via `cloudposse/label/null`.
3. **Validate** with the commands defined in `infra/CLAUDE.md` (e.g. `terraform
   fmt -check`, `terraform validate`). Report the actual output. Do not `apply`.
4. **Leave the work in the working tree** and report what you changed (paths),
   validation results, and a proposed Conventional-Commits message for the
   parent to route to `github-ops`. Do not commit.

## Conventions

- Converse with the user in Spanish (repo convention); code/comments in English.
- Your final message is consumed by the parent: summarize files changed,
  validation output, and the proposed commit message.
```

- [ ] **Step 2: Verify the file**

Run: `nvm use && node -e "const fs=require('fs');const t=fs.readFileSync('.claude/agents/infra-impl.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/)[1];['name: infra-impl','- Read','- Write','- Edit','- Bash','- Glob','- Grep'].forEach(k=>{if(!m.includes(k))throw new Error('missing '+k)});if(/mcp__/.test(m))throw new Error('impl must not have MCP tools');['Write only source code','Never touch Linear','infra/CLAUDE.md','Never apply infra'].forEach(s=>{if(!t.includes(s))throw new Error('missing: '+s)});console.log('infra-impl.md OK');"`
Expected: `infra-impl.md OK`

- [ ] **Step 3: Propose the commit (do not run it)**

```
feat(agents): add infra-impl code implementer

Thin code-only implementer for Terraform/AWS infra; defers stack to
infra/CLAUDE.md, never touches git or Linear, never applies.
```

Leave the file in the working tree.

---

### Task 7: Document the implementation flow in the root `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (add one new section under "## Working rules", after the existing "### Subagents" section)

**Interfaces:**
- Consumes: agent names from Tasks 1–6 (`solutions-architect`, `users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`).
- Produces: the durable, in-repo description of the two-layer topology and Phase A–D flow that the parent follows at implementation time.

- [ ] **Step 1: Read the current `CLAUDE.md` "### Subagents" section**

Run: `grep -n "### Subagents" CLAUDE.md`
Expected: a line number. Read the section so the new section is inserted cleanly after it and references the same three tool-layer agents already documented there.

- [ ] **Step 2: Insert the new section**

Add this section immediately after the existing "### Subagents" block (before "### Superpowers output is part of the vault"):

```markdown
### Implementation agents & flow

Two layers of agents (see `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md`):

- **Tool layer (one writer per tool):** `obsidian-vault` (docs/), `linear-pm` (Linear), `github-ops` (git/GitHub).
- **Domain layer:** `solutions-architect` (read-only planner — returns a **Coordination Plan**, writes nothing) and five **code-only** implementers: `users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`.

**Invariant:** implementers write **only source code** — they never run git or touch Linear, and they leave work in the working tree for `github-ops`. The architect writes nothing. A subagent cannot spawn another subagent, so the **parent** routes the architect's Coordination Plan to each hand.

**Flow per milestone:**
- **A — Design:** `brainstorming` → spec; `writing-plans` → plan (both under `docs/superpowers/`).
- **B — Organization:** parent → `solutions-architect` (returns Coordination Plan); parent → `obsidian-vault` (normalize/index per plan); parent → `linear-pm` (propose milestone+issues → user confirms).
- **C — Implementation (per issue):** parent → `linear-pm` (issue → In Progress) → `github-ops` (task branch) → `<svc>-impl` (implement; reads `services/<svc>/CLAUDE.md` + the vault spec note) → `github-ops` (commit + PR task→feature) → `linear-pm` (issue → Done after merge).
- **D — Milestone close:** `github-ops` proposes PR feature→`main`; the user reviews and merges (no auto-merge).

Each service's stack/conventions live in its nested `services/<svc>/CLAUDE.md` (or `infra/CLAUDE.md`), created at the start of that service's milestone — the implementer agents are thin and defer to it.
```

- [ ] **Step 3: Verify the edit**

Run: `node -e "const fs=require('fs');const t=fs.readFileSync('CLAUDE.md','utf8');['### Implementation agents & flow','solutions-architect','users-impl','events-pipeline-impl','infra-impl','Coordination Plan','no auto-merge'].forEach(s=>{if(!t.includes(s))throw new Error('missing: '+s)});const i=t.indexOf('### Subagents'),j=t.indexOf('### Implementation agents & flow'),k=t.indexOf('### Superpowers output is part of the vault');if(!(i<j&&j<k))throw new Error('section misplaced');console.log('CLAUDE.md OK');"`
Expected: `CLAUDE.md OK`

- [ ] **Step 4: Propose the commit (do not run it)**

```
docs(agents): document two-layer implementation flow in CLAUDE.md

Add the Implementation agents & flow section: tool vs domain layers,
solutions-architect Coordination Plan, code-only implementers, Phases A–D.
```

Leave the change in the working tree.

---

## Self-Review

**1. Spec coverage** (against `2026-06-26-implementation-workflow-design.md`):
- "Two layers of agents" → documented in Task 7; agents created in Tasks 1–6. ✓
- `solutions-architect` (read-only, Coordination Plan, three-section format, "why parent routes") → Task 1 (prompt embeds the three sections + the no-write rule). ✓
- Five code-only implementers with exact tool grant (Read/Write/Edit/Bash/Glob/Grep, no MCP) → Tasks 2–6; each prompt encodes "write only source code / never git / never Linear". ✓
- `solutions-architect` tool grant (Read/Grep/Glob, no write/exec/mcp) → Task 1, verified in Step 2. ✓
- "Physical files: now create 6 agents + update root CLAUDE.md" → Tasks 1–7. ✓
- "Creation order: nested CLAUDE.md deferred to each milestone" → stated as a Global Constraint and out of scope; Task 7's section text records the deferral. ✓
- Phase A–D flow → Task 7 section body. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later". Every agent file is given verbatim; the one near-duplicate (Task 3) is written out in full rather than referencing Task 2, per the no-"similar to Task N" rule. ✓

**3. Type consistency:** Agent `name:` values match filenames and the names referenced in Task 7 and in `solutions-architect`'s prompt (`users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`). Tool lists are identical across the five implementers and match the spec's grant. Infra path is `infra/` (not `services/infra/`) consistently in Task 6 and Task 7. ✓

## Related

- [[2026-06-26-implementation-workflow-design]] — the spec this plan implements.
- [[2026-06-26-3mrai-docs-vault-design]] — sibling spec (vault design).
