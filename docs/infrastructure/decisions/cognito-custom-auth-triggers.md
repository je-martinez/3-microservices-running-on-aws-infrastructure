---
title: "Cognito CUSTOM_AUTH triggers: one Lambda, three challenge triggers, over native EMAIL_OTP"
type: adr
area: infra
status: accepted
id: infra-cognito-custom-auth-triggers
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-08-05
updated: 2026-08-09
tags: [type/adr, area/infra, status/accepted, issue/JE-83]
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[ADR-0017-floci-local]]"
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[passwordless-auth-type]]"
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[2026-08-05-passwordless-otp-auth]]"
  - "[[ADR-0020-self-owned-password-reset]]"
---

# Cognito CUSTOM_AUTH triggers: one Lambda, three challenge triggers, over native EMAIL_OTP

## Context

Passwordless OTP authentication (see [[2026-08-05-passwordless-otp-auth-design]] and
[[2026-08-05-passwordless-otp-auth]]) needed a Cognito-backed challenge flow. Cognito offers two
paths: the native `USER_AUTH` flow with `PREFERRED_CHALLENGE=EMAIL_OTP` (no custom Lambda code),
or `CUSTOM_AUTH`, a Lambda-driven challenge flow requiring three triggers
(`DefineAuthChallenge`, `CreateAuthChallenge`, `VerifyAuthChallengeResponse`).

## Decision — `CUSTOM_AUTH`, never native `USER_AUTH`/`EMAIL_OTP`, in both local and production

Both paths were probed empirically against the running local stack (Floci's Cognito emulation)
before committing to either:

| Capability | Result |
|---|---|
| `CUSTOM_AUTH` triggers actually invoked by Floci | YES |
| Wrong code rejected under `CUSTOM_AUTH` | YES — `NotAuthorizedException: Incorrect challenge answer` |
| User with no password authenticates via `CUSTOM_AUTH` | YES |
| Coexistence with the existing PreTokenGeneration V2 trigger | YES — `app_user_id` claim survives |
| Native `USER_AUTH` + `PREFERRED_CHALLENGE=EMAIL_OTP` | **NO — returns tokens with no challenge issued at all** |

> [!danger] The Floci bypass — the reason this decision exists
> Floci **accepts** `InitiateAuth` with `AuthFlow=USER_AUTH` and `PREFERRED_CHALLENGE=EMAIL_OTP`
> and **silently ignores it** — it returns Access/Id/Refresh tokens directly, with no challenge
> issued. A caller who only knows an email would authenticate as that user with no code ever
> generated or checked. An E2E test asserting only "tokens were issued" would pass green against
> this bypass. This is why the design uses `CUSTOM_AUTH` in **both** local and production — not
> only in local, and not conditionally: using different flows per environment would mean the
> environment that is actually tested daily (local) never exercises the flow that ships to
> production. See [[passwordless-auth-type]] and the shipped mandatory rejection tests in
> [[testing]].

This also **narrows a prior claim**: the repo's `floci` skill states (quirk #7) that Cognito
Lambda triggers are "stored but never invoked." That holds for `PostConfirmation`/`PreSignUp` —
it does **not** hold for the three `CUSTOM_AUTH` challenge triggers, which this probe confirms
Floci genuinely invokes (`InvalidUserPoolConfigurationException: DefineAuthChallenge trigger is
not configured` when unwired; real `ChallengeName: CUSTOM_CHALLENGE` + Lambda-computed
`publicChallengeParameters` when wired).

> [!danger] Extended 2026-08-09 — `CustomMessage`, a *messaging* trigger, is also dead
> While designing the self-owned password reset ([[ADR-0020-self-owned-password-reset]]), the
> same empirical method was applied to Cognito's `CustomMessage` trigger — the hook that would
> let a `ForgotPassword` call customize the email Cognito sends. **It does not fire on Floci
> either.** A probe Lambda wired to `CustomMessage` logged **0** invocations from a real
> `ForgotPassword` API call, while a **direct control invoke of the same Lambda logged 1** —
> proving the probe itself was correctly wired and reachable, and that `ForgotPassword` genuinely
> never reaches it. This means the accurate scoping of "which Cognito Lambda triggers does Floci
> invoke" is narrower than the first narrowing above stated: **only the three `CUSTOM_AUTH`
> challenge triggers fire. Both sign-up triggers (`PostConfirmation`/`PreSignUp`) and messaging
> triggers (`CustomMessage`) are dead on this emulator.** This is also why
> [[ADR-0020-self-owned-password-reset]] could not simply hook `CustomMessage` to brand Cognito's
> native reset email — there is no hook to hang branding on, so the reset flow is self-owned
> end to end instead. The `floci` skill's quirk #7 needs a second narrowing pass to add
> `CustomMessage` explicitly (tracked here, not yet edited in the skill file itself — same
> open item the first narrowing below already flags for the skill).

## Decision — one Lambda serving all three triggers

`otp-challenge-lambda` (`infra/modules/cognito/otp-challenge-lambda/`) dispatches on
`event.triggerSource` (`DefineAuthChallenge_Authentication` /
`CreateAuthChallenge_Authentication` / `VerifyAuthChallengeResponse_Authentication`), rather than
three separate Lambda functions — mirroring the repo's only other Cognito trigger Lambda
(`pre-token-lambda/`, see [[cognito-pre-token-lambda]]). This keeps the pattern to one Terraform
Lambda resource, one IAM role, one log group, instead of tripling the infrastructure for three
functions that only ever act together as one flow.

Unlike `pre-token-lambda`, this Lambda is not zero-dependency: `CreateAuthChallenge` needs
`@aws-sdk/client-sqs` to publish `AUTH_OTP_REQUESTED` (see [[events-pipeline-design]]), so it
ships its own `package.json` and real `node_modules` in the zip.

### Code generation and custody

- 6-digit numeric code via `crypto.randomInt` (CSPRNG, not `Math.random`).
- Code lives **only** in Cognito's `privateChallengeParameters` — no new DB table. Cognito
  custodies it, encrypted, bounded by the session TTL. `publicChallengeParameters` returns only
  `{ deliveryMedium: "EMAIL" }`; verified live that the `ChallengeParameters` field in the
  `InitiateAuth` response contains no code.
- `VerifyAuthChallengeResponse` compares with `crypto.timingSafeEqual`, guarded by an explicit
  length check first (`timingSafeEqual` throws on length mismatch rather than returning false).
- Max 3 attempts, tracked via `DefineAuthChallenge`'s session array.
- 300s TTL — set from **measured** pipeline latency on this exact path (register → Mailpit):
  0.5s / 1.0s / 1.8s across three trials (cold Lambda), giving roughly 160x headroom over the
  slowest observed run, not a guess.

## Decision — single `update_user_pool` call registers all three trigger keys

`scripts/set_auth_challenge_triggers.py` sets `DefineAuthChallenge`, `CreateAuthChallenge`, and
`VerifyAuthChallengeResponse` in **one** `update_user_pool` call, following the same
settings-preserving read-modify-write pattern as `set_pre_token_trigger.py` (see
[[awscli-fallback-for-floci]]): read the pool, keep every other top-level setting, inject the
three `LambdaConfig` keys, re-apply the whole thing, then verify by re-describing the pool and
comparing all three ARNs. **Three separate scripts, each doing its own read-modify-write, would
race and clobber each other's key** — `UpdateUserPool` is a PUT over the whole `LambdaConfig`
map, so a second script's read (missing the first script's not-yet-committed write) would
silently drop it on write. One call with all three keys set together is the only safe shape.

The script's `terraform_data.auth_challenge_triggers` resource `depends_on`
`terraform_data.pre_token_trigger` (the existing PreTokenGeneration wiring), to **serialize the
two read-modify-write scripts** — running them concurrently would hit the exact same race
condition within Terraform's own apply, between two *different* scripts this time rather than
three calls within one.

## Decision — `ALLOW_CUSTOM_AUTH` in both the Terraform resource and the Python client script

`explicit_auth_flows` on the native `aws_cognito_user_pool_client` Terraform resource gained
`ALLOW_CUSTOM_AUTH` — but locally that resource is `count = 0` dead code (Floci needs the
CLI-fallback path; see [[awscli-fallback-for-floci]]), so the flow only actually takes effect
locally through `scripts/create_user_pool_client.py`'s `EXPLICIT_AUTH_FLOWS` list, which must be
edited in lockstep or the Terraform-side addition is invisible in every environment that is
actually exercised day to day.

> [!warning] The dead-code trap this decision closes
> `create_user_pool_client.py` previously only set flows at **client creation** time — it had no
> code path to update an existing client's flows. A flow added to `EXPLICIT_AUTH_FLOWS` after the
> client already existed would silently never take effect locally: `terraform apply` would report
> success (the dead-code Terraform resource "changed"), but the real Floci-created client's
> `ExplicitAuthFlows` would be untouched, and `CUSTOM_AUTH` would fail with
> `NotAuthorizedException` for a reason invisible from the Terraform output. The script now also
> **updates** an existing client's flows, closing that gap — not just creates a new one.

## Consequences

- The passwordless OTP flow ships identically wired in local and production — there is no
  environment-specific flow branch to drift or to forget testing.
- Adding a fourth `CUSTOM_AUTH`-style trigger in the future is one more `case` in the existing
  Lambda's `triggerSource` switch, not a new function/role/log-group.
- The `floci` skill's quirk #7 needs narrowing (tracked here, not yet edited in the skill file
  itself) to scope "triggers stored but never invoked" to `PostConfirmation`/`PreSignUp`/
  `CustomMessage` (updated 2026-08-09 — see the callout above) rather than sign-up triggers only.
- The `CustomMessage` finding is what forced [[ADR-0020-self-owned-password-reset]] to own the
  entire password-reset flow rather than customizing Cognito's native `ForgotPassword` email:
  there is no working hook to hang branding, a code, or [[logging-context]]-style flow logs on.

## Related

- [[ADR-0010-cognito-auth]]
- [[cognito-pre-token-lambda]]
- [[awscli-fallback-for-floci]]
- [[nginx-njs-x-user-id-injection]]
- [[ADR-0017-floci-local]]
- [[ADR-0020-self-owned-password-reset]] — the decision this `CustomMessage` finding fed into.
- [[users-service-design]]
- [[events-pipeline-design]]
- [[passwordless-auth-type]]
- [[2026-08-05-passwordless-otp-auth-design]]
- [[2026-08-05-passwordless-otp-auth]]
