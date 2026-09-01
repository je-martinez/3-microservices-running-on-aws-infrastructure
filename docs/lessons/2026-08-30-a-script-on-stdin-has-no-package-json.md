---
title: "A script on stdin has no package.json"
type: lesson
area: shared
status: active
created: 2026-08-30
updated: 2026-08-30
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[testing]]"
  - "[[package-manager]]"
  - "[[events-pipeline-design]]"
---

# A script on stdin has no package.json

## Presenting symptom

`e2e/tests/email-templates.spec.ts` failed with `SyntaxError: Cannot use import statement outside
a module`. The helper's own error message asserted **"This is a template or catalog defect, not a
missing dependency"** — a categorical, confident claim that sent the reader straight to the email
templates. The templates were fine.

> [!important] Why this note exists
> A test's own failure message named a cause the code had no way to actually verify. That message
> is the more valuable half of this lesson: a wrong categorical claim in an error path is worse
> than no claim at all, because it actively directs debugging effort away from the real fault.

## Root cause

`e2e/support/email-catalog-render.ts` piped its render script into `tsx -` over stdin. A script
read from stdin **has no path**, so Node cannot associate it with any `package.json`. The
`"type": "module"` declared in `functions/events-pipeline/package.json` therefore never applies to
it, and the script's ESM `import` statement gets parsed as CommonJS — hence the `SyntaxError`.

**Why it hid for so long.** Node 24 — the version `.nvmrc` pins (24.18.0) — detects ESM syntax on
its own and papers over the missing `"type": "module"`. Node 20 does not. So this was a
**version-dependent red**: green for anyone running the pinned Node, broken for anyone whose shell
had an older Node active — and the failure text blamed the templates rather than the toolchain.

## The fix, and the trap inside the fix

The fix is to write the script to a real `.mts` file so it has a path, in a `mkdtemp` directory,
removed in a `finally`.

The first attempt put that temp file in `os.tmpdir()`. That fixed the `SyntaxError` — and then
failed differently, with `ERR_PACKAGE_IMPORT_NOT_DEFINED: Package import specifier "#email/catalog"
is not defined`.

> [!warning] Both resolution inputs come from the same lookup, not just one
> `"type": "module"` **and** the `#email/*` subpath imports map are both read from the **nearest
> `package.json` walking up from the script's own path**. `os.tmpdir()` has no `package.json`
> above it at all, so the second resolution failed exactly like the first, just later and with a
> different error. The file has to live **inside** the package whose imports map it uses —
> generalize this: moving a script into a temp directory silently changes its module resolution,
> and subpath imports (`#foo/*`) are the part that breaks second, right after you think you've
> fixed it.

**A dead end worth recording so nobody retries it.** `--input-type=module` is not a fix here: Node
rejects it with `ERR_INPUT_TYPE_NOT_ALLOWED` whenever an entry point is passed, and `tsx -` is an
entry point.

## The meta-lesson

A categorical error message ("this is a template defect") that names a cause the code cannot
actually verify sends every future reader down the wrong path. The message was rewritten to report
the Node version in use and to distinguish a module-resolution error (toolchain) from a render
error (catalog) — stating what it observed rather than concluding what it could not know. The same
discipline applies to any helper that catches an exception and re-labels it: only assert a cause
the surrounding code actually checked.

## Reference material

- Fix shipped in commit `8ac9cac` on `feature/tracking-go-migration` (PR #74).
- Files: `e2e/support/email-catalog-render.ts`, `.gitignore`.
- Verified 10/10 on both Node 20.18.3 and Node 24.18.0.

## Related

- [[testing]] — the three-layer testing convention `email-templates.spec.ts` sits under.
- [[package-manager]] — sibling convention on Node/toolchain pinning in this repo (`.nvmrc`,
  pnpm workspace); this lesson is a module-resolution gotcha in the same toolchain.
- [[events-pipeline-design]] — owns the `functions/events-pipeline` package, its
  `"type": "module"` declaration, and the `#email/*` subpath imports map this bug resolves
  against.
