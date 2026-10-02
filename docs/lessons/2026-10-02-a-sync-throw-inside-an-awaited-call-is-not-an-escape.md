---
title: A sync throw inside an awaited call is not an escape
type: lesson
area: users
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/low
related:
  - "[[logging-context]]"
  - "[[testing]]"
---

# A sync throw inside an awaited call is not an escape

## What looked wrong

Users' realtime bridge `publishToUser` threw synchronously on its first call when the environment failed to parse. That contradicted its "never throws" doc comment, so it read as a defect.

## Why it was not one

The throw could not escape, for three independent reasons:

- `main.ts` validates the same schema at module load, so a bad env kills the process at boot, before any call to `publishToUser`.
- `ConfigModule.forRoot` only adds missing keys and never breaks a valid env.
- The caller `await`s `publishToUser` inside an async method, so a synchronous throw becomes a rejection. `create-notification.command.ts` catches it in its try/catch, logs `reason=push_preparation_failed`, and the notification is still created.

The bridge itself is being replaced by a Nest provider in a parallel change.

## Rule

Before "fixing" a guarantee, check whether the execution context already provides it, and record the evidence (the boot-time validation, the awaiting caller, the catch site). A doc comment that disagrees with the code is a prompt to investigate, not proof of a bug.

## Related

- [[logging-context]]
- [[testing]]
