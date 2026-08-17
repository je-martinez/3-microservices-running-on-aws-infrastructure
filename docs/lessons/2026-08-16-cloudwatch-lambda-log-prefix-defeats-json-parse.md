---
title: CloudWatch's Lambda Log Prefix Defeats a JSON-Anchored Parse
type: lesson
area: shared
status: active
created: 2026-08-16
updated: 2026-08-16
tags:
  - area/shared
  - type/lesson
  - severity/high
related:
  - "[[logging-context]]"
  - "[[openobserve-runbook]]"
  - "[[2026-08-14-counter-metrics-need-a-clock-and-a-window]]"
  - "[[ADR-0018-observability-openobserve]]"
---

# CloudWatch's Lambda Log Prefix Defeats a JSON-Anchored Parse

## The symptom

Lambda log records kept arriving in OpenObserve with `severity` `0` and no `service_name`,
`app_event`, or any other structured field — indistinguishable from unstructured noise on every
dashboard. This persisted across **multiple rounds of fixing**, long after the Lambda source
code itself had been corrected to emit proper `severity_text`/`severity_number` fields (see
[[logging-context#Severity must reach the record's native fields]]). The user reported it more
than once ("algunas siguen saliendo como severity zero"), which is what made it worth writing
down: a bug that survives its own fix, twice, is a sign of a second break, not a failed first
attempt.

## Two independent causes, discovered in sequence

The pipeline had **two** breaks in it, and fixing either one alone changed nothing observable —
so each fix looked like it had failed.

### 1. The deploy gap

A Lambda does **not** rebuild with `docker compose up --build` the way the services do. Source
was fixed, tests passed, and the deployed function kept running days-old code. Fixed by adding
`infra/scripts/redeploy_lambdas.py` and a `make redeploy-lambdas` target (build +
`update-function-code` for all seven functions).

### 2. The parse gap (the deeper one)

The OTel collector's `transform/parse_body` processor only parsed a body into attributes when
the body started with `{`:

```
merge_maps(attributes, ParseJSON(body), "upsert") where IsMatch(body, "^\\s*\\{")
```

But a Lambda's stdout does not reach CloudWatch verbatim — the runtime **prepends its own
tab-separated prefix**:

```
2026-08-17T05:00:27.457Z\t<requestId>\tINFO\t{"severity_text":"WARN",...}
```

So the body does not start with `{`, the guard skipped it, and a perfectly well-formed
application log line arrived as opaque text. The producers were correct and this parse simply
never ran on them.

## Why it stayed invisible

Both halves had to be right, and only one was ever right at a time. Fixing the Lambda source
produced no visible change (still undeployed); redeploying produced no visible change (the
prefix still defeated the parse). Nothing errored — `error_mode: ignore` plus a `where` guard
that simply does not match is silent by construction. A non-matching OTTL condition is not a
failure, it is a no-op, and no-ops do not appear in logs.

## The fix

A second `merge_maps` statement in the same processor extracts the embedded JSON from behind the
runtime prefix, anchored on the prefix's exact shape (timestamp, request id, level,
tab-separated) rather than "find a `{` anywhere" — so a line that merely *contains* a brace (a
stack trace, a message quoting JSON) is not silently reinterpreted as structure:

```
merge_maps(attributes, ParseJSON(ExtractPatterns(body,
  "^[0-9TZ:.\\-]+\\t[0-9a-f-]+\\t[A-Z]+\\t(?P<json>\\{.*)$")["json"]), "upsert")
  where attributes["service_name"] == nil
    and IsMatch(body, "^[0-9TZ:.\\-]+\\t[0-9a-f-]+\\t[A-Z]+\\t\\s*\\{")
```

(`observability/otel-collector-config.yaml`, `transform/parse_body`.) Guarded on
`attributes["service_name"] == nil` so it cannot overwrite a record the first statement already
parsed — the two statements are complementary passes over the same processor, not competing
ones.

## The generalizable rules

> [!warning] A structurally-correct producer + a wrong destination = check every hop that rewrites the payload
> When a log line is structurally correct at the producer but wrong at the destination, the
> fault is in the **transport**, and every hop that rewrites the payload is a suspect — here,
> the Lambda runtime's own stdout-to-CloudWatch framing. Read the actual stored `body` at the
> destination rather than trusting the producer's output.

> [!warning] A silent OTTL `where` guard that matches nothing is this repo's most repeated collector failure mode
> This is at least the fifth instance of a non-matching OTTL condition producing silent no-ops
> in this collector config — see the `resource.attributes` vs `attributes` family of bugs
> documented in [[openobserve-runbook#How the routing works, and the four bugs it is easy to
> reintroduce]]. Verify a new statement by observing a record it **changed**, never by the
> absence of an error.

> [!info] "The fix doesn't work" may mean there is a second break downstream
> When a fix produces no observable change, check whether a second, independent break sits
> further down the same pipeline before concluding the fix itself was wrong. Here, the source
> fix and the collector fix each looked ineffective in isolation and were both required.

## Related

- [[logging-context]] — the shared severity/`service_name` fields this fix makes reach
  OpenObserve for Lambda producers; see its "Severity must reach the record's native fields"
  section for the producer-side half of this story.
- [[openobserve-runbook]] — the collector's routing rules and the broader family of silent
  `resource.attributes`/`attributes` mismatches this bug belongs to.
- [[2026-08-14-counter-metrics-need-a-clock-and-a-window]] — another OpenObserve/collector
  lesson from the same observability surface, verified empirically in the same style.
- [[ADR-0018-observability-openobserve]] — why OpenObserve is the logs backend this pipeline
  feeds.
