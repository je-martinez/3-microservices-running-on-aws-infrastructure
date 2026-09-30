---
title: "A TTY-less prompt resolves to a silent success"
type: lesson
area: events-pipeline
status: active
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/lesson
  - area/events-pipeline
  - status/active
  - severity/high
related:
  - "[[email-templates]]"
  - "[[code-comments]]"
---

# A TTY-less prompt resolves to a silent success

An interactive prompt in a non-interactive environment does not hang and does not fail. It resolves immediately and the process exits `0`. **Exit 0 plus an empty log is the signature.**

## What happened

The events-pipeline image runs the react-email preview server (`email dev`). The CLI does **not** bundle its preview UI. On first run it detects that `@react-email/preview-server` is missing and **prompts** to install it. Inside a container (or CI) there is no TTY, so the prompt resolves at once and the process exits `0` having started **no server at all**.

`docker build` cannot catch this: the build succeeds. Only running the image reveals it. Verified: the container exited 0 with an empty log until the dependency was declared.

## The version trap

The fix is to declare `@react-email/preview-server` explicitly in `package.json`, pinned to an **exact** version (`4.3.2`), not a caret range. That version must **equal** the resolved `react-email` version: the CLI compares the two and re-prompts (same silent exit) when they differ.

A `^` range let pnpm resolve `5.2.10` against `react-email` `4.3.2`, which reproduced the failure exactly. When bumping `react-email`, bump the preview server in lockstep.

## Reusable rule

- Distinguish **build-time success** from **runtime success**: a green image build proves nothing about a CLI that negotiates with a terminal.
- After any change to a tool that may prompt, run the container and confirm it **produces output and stays up**; do not trust the exit code alone.
- Prefer declaring every dependency a CLI would offer to install on first run.

## Related

- [[email-templates]]
- [[code-comments]]
- [[2026-09-30-go-test-discards-a-passing-packages-output]]
