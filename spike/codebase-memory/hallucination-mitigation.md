# Preventing the `/v1/users/login-history` class of error

Follow-up to Part B. The engine reported a route that does not exist. This is what
caused it, whether it can be prevented, and what it costs.

## Two phantoms, not one

Re-checking found a second false positive the first pass missed, and the two have
**different causes** — which matters, because one filter catches only the first.

| Reported route | Reality | Cause |
|---|---|---|
| `/v1/users/login-history` | Does not exist anywhere | A **string literal** in a test assertion: `expect(isPublicRoute("GET", "/v1/users/login-history")).toBe(false)` — deliberately a non-existent path, used to prove the matcher does not exempt by loose prefix |
| `/v1/health-probe` | Exists, but only inside a test | A **real route registration** — `app.get("/v1/health-probe", …)` — on a throwaway Fastify app in `routes.test.ts:310` |

The first is "a string that looks like a route". The second is "a genuine route in code
that never ships". No single heuristic separates both from production routes.

## What the graph already knows

The metadata to catch them is present. It is simply not applied by
`get_architecture`, which is the tool that reported them.

Every `Route` node carries `method` and `in_degree`:

| Route | `method` | `in_degree` |
|---|---|---|
| `/v1/users/register` (real) | `POST` | 1 |
| `/v1/users/login-history` (phantom) | *(empty)* | 0 |

A route parsed from a **registration** gets an HTTP verb and an inbound edge from its
handler. A route scraped from a **string literal** gets neither.

## Filter 1 — method + in_degree

```cypher
MATCH (r:Route)
WHERE r.method <> '' AND r.in_degree > 0
RETURN r.method, r.name
ORDER BY r.name
```

Validated against `services/users/openapi.yaml` (the generated contract, so a
trustworthy reference):

```
openapi routes: 12 | filtered graph: 13
false negatives: 0
false positives: 1   → GET /v1/health-probe
```

**Zero false negatives.** It also corrects an error in the Part B writeup: I reported
that `/v1/users/e2e-identity` was missed. It was not — the graph has it with
`method: GET, in_degree: 1`. `get_architecture` rendered it without its method, and I
read that as absence. The graph was right; the presentation tool was not.

So filter 1 removes the string-literal phantom entirely. The surviving false positive
is the test-registered route, which by construction has a method and a handler.

## Filter 2 — exclude test-origin, and why it does not compose

`Route` nodes do **not** carry `is_test`. The originating node does:

```cypher
MATCH (c)-[:HANDLES|CALLS|REFERENCES]->(r:Route)
WHERE r.name = '/v1/health-probe'
RETURN c.name, c.file_path, c.is_test
```

```
tests/features/users/http/routes.test.ts | true
```

The signal is there, one hop away. But the traversal cannot be combined with a filter,
because of an engine limitation found while trying:

**When a `MATCH` contains an unlabeled relationship (`(c)-->(r)`), `query_graph`
silently ignores the `WHERE` and `RETURN` clauses** and returns an unrelated node dump.
Single-node matches honor both. This is not documented; it was found by the query
returning Prisma migration variables instead of routes.

So filter 2 works as a *lookup* ("is this specific route test-origin?") but not as a
*sweep* ("give me all non-test routes") on the current version.

## Practical recommendation

**Use filter 1 as the default query, and treat a test-origin check as a second step for
anything surprising.**

```cypher
-- Step 1: real routes (drops string-literal phantoms, 0 false negatives)
MATCH (r:Route)
WHERE r.method <> '' AND r.in_degree > 0
RETURN r.method, r.name ORDER BY r.name

-- Step 2: for any route you do not recognize, check its origin
MATCH (c)-[:HANDLES|CALLS|REFERENCES]->(r:Route)
WHERE r.name = '<the suspicious route>'
RETURN c.file_path, c.is_test
```

Accuracy with step 1 alone: **13 reported, 12 correct, 1 test-scoped, 0 missing.**
That is a 92% precision / 100% recall result, versus the unfiltered
`get_architecture` output which added a route that exists nowhere.

## What this does and does not fix

**Fixes:** the specific failure that undermined trust — reporting a path that exists
only inside an assertion. That one is fully preventable with metadata the engine
already computes.

**Does not fix:** the general problem. Filter 1 is hand-written for routes. The same
class of error will appear in any extracted entity type, and each will need its own
validity predicate discovered the same way — by finding a wrong answer first.

**The deeper point, which cuts against the engine's headline claim:** the tool markets
itself on answering structural questions without reading files. Both phantoms were
caught only by reading source. The filter reduces how often verification is needed; it
does not remove the need. Part B's condition stands unchanged — **treat output as a
lead, not a fact.**

That is not fatal. A lead that is 92% precise and 100% complete, delivered in
milliseconds, is genuinely useful for the blast-radius question Part A2 exposed. It is
just not the "99% fewer tokens, no file reads" story the README tells, because the
tokens saved get partly spent verifying.

## Corrections to earlier spike documents

- **Part B claimed `/v1/users/e2e-identity` was missed.** It was not. The graph has it
  correctly; `get_architecture` displayed it without its method. The engine's route
  extraction is better than Part B credited — the presentation layer is the weak point.
- **Part B counted "one phantom route".** There are two, from two different causes.
