# app_user_id Token Claim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `app_user_id` claim (the Prisma `usr_` id) to the Cognito token, sourced from a `custom:app_user_id` attribute `register` sets, copied in by a Pre-Token-Generation V2 Lambda. Do NOT change `x-user-id` (stays the sub) or identity resolution.

**Architecture:** Cognito pool gains a `custom:app_user_id` String attribute. `register` generates the `usr_` id before `signUp` and passes it so the attribute is set at sign-up. A Pre-Token-Generation V2 Lambda (the repo's first) copies the attribute into the `app_user_id` claim on both id + access tokens.

**Tech Stack:** Terraform, Cognito (Floci), Lambda (nodejs20), Fastify/Cognito SDK, Vitest.

## Global Constraints

- **INVARIANT — identity resolution untouched.** `x-user-id` stays the Cognito `sub` (nginx+njs); the service keeps resolving by `cognitoSub` (`findByIdOrCognitoSub`). This plan ONLY ADDS the `app_user_id` claim. Do NOT edit the nginx njs script, the gateway, or `get-me.ts`/`update-profile.ts`.
- **Verified (earlier POCs):** Pre-Token-Generation V2 triggers DO fire in Floci; custom attributes are emitted and readable in the trigger event. (PostConfirmation does NOT fire — different trigger; the `register.ts` comment is about that one.)
- **Client read/write attributes:** neither the native client nor the awscli-fallback script sets explicit `read_attributes`/`write_attributes` — both default to ALL attributes. So a new custom attribute is automatically writable/readable; **no client change needed**, only the pool `schema {}`.
- **Node:** `nvm use` before pnpm/node (24.18.0), from `services/users/`. Zod imports `from "zod/v4"`.
- **Terraform** via `terraform -chdir=...`; provider pinned `= 5.31.0`; `terraform fmt` must pass. Floci forbids a 2nd apply → gateway/pool E2E needs teardown+rebuild (Task 5, NEEDS user OK).
- **Git:** implementers write only source; main session commits. Language: code English, converse Spanish.

---

### Task 1: `signUp` accepts appUserId + sets the custom attribute

**Files:**
- Modify: `services/users/src/shared/auth/auth-provider.ts`
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Test: `services/users/tests/shared/auth-provider.test.ts` (existing — update signatures + add assertion)

**Interfaces:**
- Produces: `AuthProvider.signUp(email, password, appUserId): Promise<CognitoSignUpResult>`.

- [ ] **Step 1: Update the existing signUp test + add the attribute assertion**

In `tests/shared/auth-provider.test.ts`, every `p.signUp(...)` call gains a 3rd arg (the app user id). Add a test asserting the attribute is sent:
```ts
it("signUp sets custom:app_user_id from the app user id", async () => {
  const send = vi.fn(async () => ({ User: { Attributes: [{ Name: "sub", Value: "sub-1" }] } }));
  const p = new CognitoAuthProvider({ send } as any, "pool", "client");
  await p.signUp("a@b.co", "P@ss", "usr_ABC");
  const createCall = send.mock.calls[0][0]; // AdminCreateUserCommand
  const attrs = createCall.input.UserAttributes;
  expect(attrs).toEqual(expect.arrayContaining([{ Name: "custom:app_user_id", Value: "usr_ABC" }]));
});
```
Also update the existing `signUp maps UsernameExistsException...` test's `p.signUp("dup@x.co", "P@ss")` → add a 3rd arg `"usr_X"`.

- [ ] **Step 2: Run to fail**

Run: `nvm use && pnpm test -- auth-provider.test`
Expected: FAIL — `signUp` takes 2 args; no `custom:app_user_id` attribute.

- [ ] **Step 3: Implement**

In `auth-provider.ts`, change the interface method to:
`signUp(email: string, password: string, appUserId: string): Promise<CognitoSignUpResult>;`

In `cognito-auth-provider.ts` `signUp`, add the param and the attribute:
```ts
async signUp(email: string, password: string, appUserId: string): Promise<CognitoSignUpResult> {
  // ...inside AdminCreateUserCommand UserAttributes, add:
  //   { Name: "custom:app_user_id", Value: appUserId },
```
Keep everything else (AdminSetUserPassword, the "no sub" guard) unchanged.

- [ ] **Step 4: Run to pass**

Run: `nvm use && pnpm test -- auth-provider.test`
Expected: PASS. (`pnpm build` will fail until register passes the 3rd arg — that's Task 2; note it, don't fix here.)

- [ ] **Step 5: Commit** *(main session)*

---

### Task 2: `register` generates the id before signUp

**Files:**
- Modify: `services/users/src/features/users/commands/register.ts`
- Test: `services/users/tests/features/users/commands/register.test.ts` (existing — extend)

**Interfaces:**
- Consumes: `signUp(email, password, appUserId)` (Task 1).

- [ ] **Step 1: Add/extend the failing test**

In `register.test.ts`, assert `auth.signUp` receives the generated `usr_` id and that the created row's id equals it:
```ts
it("passes the generated usr_ id to signUp (so it lands in custom:app_user_id)", async () => {
  // arrange the existing register test harness; capture signUp's 3rd arg
  const signUp = vi.fn(async () => ({ sub: "sub-1", email: "a@b.co", userPoolId: "p", clientId: "c" }));
  // ...build the command with { auth: { signUp }, db, env } per the existing test's style
  const created = await cmd.execute({ email: "a@b.co", password: "P@ss", fullName: "A", e2eSource: false });
  const appUserIdArg = signUp.mock.calls[0][2];
  expect(appUserIdArg).toMatch(/^usr_/);
  expect(created.id).toBe(appUserIdArg); // row id === the id passed to signUp
});
```
(Match the existing register.test.ts harness — how it mocks `db.user.create`, `auth`, `env`. Reuse its patterns.)

- [ ] **Step 2: Run to fail**

Run: `nvm use && pnpm test -- register.test`
Expected: FAIL — today `signUp` is called before `id` exists / with only 2 args.

- [ ] **Step 3: Implement the reorder**

In `register.ts` `execute`, move `const id = generateId(MODEL_ID_PREFIXES.User);` ABOVE the `signUp` call and pass it:
```ts
const id = generateId(MODEL_ID_PREFIXES.User);
const signUp = await this.auth.signUp(input.email, input.password, id);
const tags = input.e2eSource ? ["E2E Source"] : [];
const row = await runAsActor(id, () => this.db.user.create({ data: { id, email: input.email, cognitoSub: signUp.sub, /* unchanged */ } }));
// ...rest of execute (best-effort local identity capture) unchanged
```
Keep the comment block explaining why `id` is reserved up front; it still applies.

- [ ] **Step 4: Run to pass + full build**

Run: `nvm use && pnpm test -- register.test && pnpm build`
Expected: PASS; build now clean (register supplies the 3rd arg).

- [ ] **Step 5: Full suite + lint**

Run: `nvm use && pnpm test && pnpm lint`
Expected: ALL pass (the signUp signature change ripples only through register + tests).

- [ ] **Step 6: Commit** *(main session)*

---

### Task 3: Cognito custom attribute (Terraform)

**Files:**
- Modify: `infra/modules/cognito/main.tf`

**Interfaces:** adds `custom:app_user_id` (String) to the user pool schema.

- [ ] **Step 1: Add the schema block to the pool**

In `aws_cognito_user_pool.this`, add:
```hcl
  schema {
    name                = "app_user_id"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }
```
No client change needed (read/write attributes default to all — confirmed).

- [ ] **Step 2: Format + validate**

Run: `terraform -chdir=infra/modules/cognito fmt && terraform -chdir=infra/environments/local validate`
Expected: `Success! The configuration is valid.` Do NOT apply.

- [ ] **Step 3: Commit** *(main session)*

---

### Task 4: Pre-Token-Generation Lambda + trigger (Terraform, first Lambda)

**Files:**
- Create: `infra/modules/cognito/pre-token-lambda/index.mjs`
- Modify: `infra/modules/cognito/main.tf` (archive_file + lambda + role + permission + lambda_config on the pool)

**Interfaces:** wires the Lambda as the pool's Pre-Token-Generation V2 trigger.

- [ ] **Step 1: Create the handler**

Create `infra/modules/cognito/pre-token-lambda/index.mjs`:
```js
// Pre-Token-Generation V2 trigger: copy the app_user_id custom attribute into
// an app_user_id claim on both the id and access tokens. No DB access — the id
// is read from the trigger event's userAttributes (set by register at sign-up).
export const handler = async (event) => {
  const appUserId = event.request.userAttributes["custom:app_user_id"];
  const claims = appUserId ? { app_user_id: appUserId } : {};
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
```

- [ ] **Step 2: Add the Lambda infra (establishes the repo's first Lambda pattern)**

In `infra/modules/cognito/main.tf`, add (adjust naming to the module's cloudposse/label convention via `var.context`):
```hcl
data "archive_file" "pre_token" {
  type        = "zip"
  source_dir  = "${path.module}/pre-token-lambda"
  output_path = "${path.module}/pre-token-lambda.zip"
}

resource "aws_iam_role" "pre_token" {
  name               = "${var.context.id}-pretoken-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.context.tags
}

resource "aws_lambda_function" "pre_token" {
  function_name    = "${var.context.id}-pretoken"
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  role             = aws_iam_role.pre_token.arn
  filename         = data.archive_file.pre_token.output_path
  source_code_hash = data.archive_file.pre_token.output_base64sha256
  tags             = var.context.tags
}

resource "aws_lambda_permission" "pre_token_cognito" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}
```
And add to `aws_cognito_user_pool.this`:
```hcl
  lambda_config {
    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.pre_token.arn
      lambda_version = "V2_0"
    }
  }
```

- [ ] **Step 3: Format + validate**

Run: `terraform -chdir=infra/modules/cognito fmt && terraform -chdir=infra/environments/local init && terraform -chdir=infra/environments/local validate`
Expected: init succeeds (archive_file provider available), validate → Success. Do NOT apply.
> If `archive` provider isn't installed, `terraform init` pulls it — that's expected on first use of `archive_file`.

- [ ] **Step 4: Commit** *(main session)*

---

### Task 5: End-to-end verification (teardown + rebuild) — NEEDS USER OK

**Files:** none (verification only).

> Pool schema + Lambda changed; Floci forbids a 2nd apply → requires `make bootstrap` (destructive: resets Cognito/DB IDs, regenerates `.env`). Get the user's explicit OK before running.

- [ ] **Step 1: Rebuild**

```bash
make bootstrap
```
Expected: apply succeeds (custom attribute + Lambda + trigger created), users up, bootstrap.sh OK.

- [ ] **Step 2: The token carries app_user_id**

```bash
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
source .env
API_ID=$(terraform -chdir=infra/environments/local output -raw api_id)
BASE="http://localhost:4566/restapis/$API_ID/\$default/_user_request_"
REG=$(curl -s -X POST "$BASE/v1/users/register" -H 'Content-Type: application/json' -d '{"email":"claim@example.co","password":"P@ssw0rd!2026","fullName":"Claim"}')
RID=$(echo "$REG" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username claim@example.co --password 'P@ssw0rd!2026' --permanent --endpoint-url http://localhost:4566
TOK=$(aws cognito-idp admin-initiate-auth --user-pool-id "$COGNITO_USER_POOL_ID" --client-id "$COGNITO_CLIENT_ID" --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME=claim@example.co,PASSWORD='P@ssw0rd!2026' --endpoint-url http://localhost:4566 | python3 -c "import sys,json;print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")
echo "registered id: $RID"
echo "token app_user_id: $(echo "$TOK" | python3 -c "import sys,json,base64;p=sys.stdin.read().strip().split('.')[1];p+='='*(-len(p)%4);print(json.loads(base64.urlsafe_b64decode(p)).get('app_user_id','<<MISSING>>'))")"
```
Expected: `token app_user_id` equals the registered `usr_` id.

- [ ] **Step 3: Invariant checks (nothing else changed)**

```bash
echo "me WITH bearer: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$BASE/v1/users/me")"   # 200
echo "me no token:    $(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/users/me")"                                   # 401
```
Expected: 200 / 401 (x-user-id path unchanged). Confirm the Lambda's `/aws/lambda/…` log group exists. Clean up test users.

---

## Self-Review

**Spec coverage:**
- signUp sets custom:app_user_id → Task 1. ✓
- register reorder (id before signUp) → Task 2. ✓
- Cognito custom attribute → Task 3. ✓
- Pre-Token Lambda + trigger (first Lambda) → Task 4. ✓
- E2E token-carries-claim + invariant → Task 5. ✓
- INVARIANT (x-user-id/resolution untouched) → Global Constraints + Task 5 Step 3. ✓
- No client read/write attribute change needed → Task 3 (confirmed defaults). ✓

**Placeholder scan:** No TBD/TODO; handler + HCL + reorder shown. Lambda naming defers to the module's label convention (noted, not a gap).

**Type consistency:** `signUp(email, password, appUserId)` identical across interface (Task 1), impl (Task 1), and caller (Task 2); the claim/attribute name `app_user_id`/`custom:app_user_id` consistent across service (Task 1) and Lambda (Task 4).

**Known risk:** Task 5 needs a destructive rebuild + user OK. Tasks 1–2 are service-only (fast); 3–4 are Terraform (validate only, no apply until Task 5).

## Related

- [[2026-07-12-app-user-id-token-claim-design]]
- [[ADR-0010-cognito-auth]]
