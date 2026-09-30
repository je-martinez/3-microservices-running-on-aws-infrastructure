---
title: "go test discards a passing package's output"
type: lesson
area: tracking
status: active
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/high
related:
  - "[[testing]]"
  - "[[code-comments]]"
---

# go test discards a passing package's output

A skipped test and a passing test are indistinguishable in default `go test` output. If a skip must be visible, print it from **outside** the test binary.

## The limitation

`go test` buffers and discards a passing package's stdout and stderr unless `-v` is passed. A gate's own opt-out warning, printed from `TestMain`, is therefore **invisible** in a default run. Verified: `grep -c "DATABASE TESTS WERE SKIPPED"` returns `1` with `-v` and `0` without it.

The only channel Go surfaces reliably without `-v` is a **failure**, and failing is exactly what an opt-out exists not to do. Without a database the mysql adapter's tests skip while the package still prints `ok`.

## The design that follows

The always-visible half of the warning is printed by **make** (the `test-no-db` target), whose output is never buffered. The test keeps the detailed inventory for anyone running with `-v`.

## Both DSN variables, or a silent skip

The `test-db` target must set **both**:

- `TRACKING_DATABASE_URL` for the creation, reads and transition suites;
- `TRACKING_TEST_MYSQL_DSN` for the count and soft-delete suites.

Setting only one leaves the other group silently skipping. That split is why a documented skip list said "eleven tests" when a database-less run actually skips fourteen. See [[2026-09-30-discover-the-dsn-do-not-hardcode-the-port]] for how the DSN is obtained.

## Related

- [[testing]]
- [[code-comments]]
- [[2026-09-30-discover-the-dsn-do-not-hardcode-the-port]]
- [[2026-09-30-a-tty-less-prompt-resolves-to-a-silent-success]]
