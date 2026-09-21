---
title: "A shared stream widens every scoped count"
type: lesson
area: shared
status: active
created: 2026-09-20
updated: 2026-09-20
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[browser-rum]]"
  - "[[openobserve-runbook]]"
  - "[[2026-09-19-web-rum-integration-design]]"
---

# A shared stream widens every scoped count

## Symptom

A dashboard panel titled "Browser traces" reads 1477. The real figure is 55. Nothing errors, no
query fails, and the number is plausible enough on its own to be believed — it looks like a
healthy count on a system with real traffic, not like a bug.

## Mechanism

The panel counted `COUNT(DISTINCT trace_id)` over `rum_traces`, a stream that at the time held
only browser spans. Its scope — "browser traces only" — lived in the stream's identity, never
stated in the query itself. When browser trace spans moved into the shared `app_traces` stream
(so a browser call and the backend chain it caused would render as one waterfall instead of two
searches in two streams), the query kept working exactly as written and started counting every
backend trace too. Nothing about the panel changed; its meaning did. The failure mode is
invisible by construction: a SELECT with no WHERE clause is not wrong syntax, so nothing catches
it, and the resulting number is still a plausible trace count — just the wrong one.

## The rule

An aggregate's scope belongs in its query, not in the name of the stream it reads. Before
merging two sources into one stream, find every aggregate over the destination stream and ask
what each one silently starts including. A filter that looks redundant while a stream has one
producer is what keeps the number correct once it gains a second — write it before the merge,
not after the dashboard is caught lying.

## Related

- [[browser-rum]] — the standing convention this lesson's rule now appears in, as the
  cross-cutting requirement that any `app_traces` aggregate meaning "browser only" says so in
  SQL.
- [[openobserve-runbook]] — local OpenObserve operations and query behavior this lesson's
  mechanism depends on.
- [[2026-09-19-web-rum-integration-design]] — Decision 3, whose choice to share `app_traces`
  between browser and service spans created the trap this lesson documents.
