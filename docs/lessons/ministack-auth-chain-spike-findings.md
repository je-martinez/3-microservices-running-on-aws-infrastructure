---
title: "Ministack auth-chain spike findings"
type: lesson
area: infra
status: active
created: 2026-06-28
updated: 2026-06-28
tags: [type/lesson, area/infra, status/active, severity/medium]
related:
  - "[[ADR-0012-ministack-local]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
---

# Ministack auth-chain spike findings

Empirical findings from the JE-25 spike against **Ministack 1.3.69-full**. These are gate-passed facts — every future infra task that touches local auth, API Gateway, or ECS locally (JE-28 Cognito, JE-30 API Gateway, JE-36 load balancer) must treat this note as input, not as suggestions.

> [!important] Ministack version
> All findings below are specific to **Ministack 1.3.69-full**. If the Ministack version is bumped, re-validate each finding.

## Proven local topology

The full auth chain that passed the smoke test:

```
Client
  │  (Bearer JWT)
  ▼
API Gateway v2  ──[JWT authorizer]──▶  Cognito (Ministack)
  │  (HTTP_PROXY, auth passed)
  ▼
ECS task: Nginx container  (on 3mrai_3mrai-network)
  │  (proxy_pass by Docker DNS name)
  ▼
Backend container  (on 3mrai_3mrai-network)
```

Smoke test results:

- Unauthenticated request → `401`
- Authenticated request → `200`, body `spike-ok-via-nginx`

## Findings

### DNS and networking

1. **Docker embedded DNS is the local resolver.** Docker's embedded DNS server at `127.0.0.11` resolves compose service names natively from inside Ministack-launched ECS task containers. Those containers run as real Docker containers on `3mrai_3mrai-network`. The correct Nginx pattern is:

   ```nginx
   resolver 127.0.0.11 valid=5s;
   set $backend <compose-service-name>;
   proxy_pass http://$backend:<port>;
   ```

   Using a variable (`set $backend`) forces Nginx to resolve at request time rather than at startup, which avoids failures when the upstream container is not yet ready.

2. **Route 53 records in Ministack do NOT affect the container OS resolver.** R53 is not the DNS mechanism for container-to-container routing; Docker embedded DNS is. Do not waste time creating Route 53 records for local service discovery.

3. **The API Gateway `invoke_url` Terraform output is not locally routable.** Ministack emits a real AWS-format domain as the `invoke_url`. The locally reachable URL has the form:

   ```
   http://<api-id>.execute-api.localhost:4566
   ```

   Use this form in local smoke tests and runbooks.

4. **Integration URI bootstrap required post-launch.** The HTTP_PROXY integration URI must point at the Nginx ECS task container. The container IP is not known until after `terraform apply` launches it. A local bootstrap step must:
   1. `docker inspect` the running container to get its IP on `3mrai_3mrai-network`.
   2. Patch the integration via `aws apigatewayv2 update-integration --integration-uri http://<ip>:<port>`.

   Production replaces this with a stable DNS name (service discovery or ALB DNS). This bootstrap step is local-only.

### Provider and Ministack quirks

5. **AWS provider must be pinned to `= 5.31.0`.** Provider v5.100 crashes Ministack 1.3.69 with a nil pointer panic. Do not upgrade the provider without validating against the current Ministack version.

6. **Use inline `ingress`/`egress` blocks in `aws_security_group` — not standalone rule resources.** Standalone `aws_vpc_security_group_ingress_rule` and `aws_vpc_security_group_egress_rule` resources crash Ministack with `index out of range [0]`. Always use:

   ```hcl
   resource "aws_security_group" "example" {
     ingress { ... }
     egress  { ... }
   }
   ```

7. **Ministack ALB emulator only supports `target_type = lambda`.** Target types `ip` and `instance` return "Target type not supported". This is the root cause that necessitates [[ADR-0016-local-apigw-nginx-ecs]]: the production chain (API GW → ALB → Fargate) cannot be emulated locally with an ALB.

8. **Nginx config cannot be mounted as a host volume into Ministack ECS tasks.** Ministack ECS task containers cannot mount host volumes. Inject the Nginx config by embedding it in a shell `command` inside the container definition (e.g., write the config to a file via `sh -c 'cat > /etc/nginx/conf.d/default.conf << EOF ... EOF && nginx -g "daemon off;"'`).

9. **`skip_requesting_account_id` is the correct provider attribute name** (not `skip_requested_account_id`) in AWS provider v5. Typos in this attribute cause silent failures where the provider tries to call real AWS to resolve the account ID.

10. **All service endpoints must be declared in the provider `endpoints{}` block.** If a service (`lambda`, `route53`, `apigateway`, etc.) is not declared there, Terraform calls the real AWS endpoint instead of Ministack. Verify the `endpoints{}` block covers every service used in the module.

### Auth and JWT authorizer

11. **JWT authorizer issuer must be the AWS-format URL, not the localhost endpoint.** Ministack mints tokens with the AWS-format `iss` claim. The correct issuer value:

    ```
    https://cognito-idp.us-east-1.amazonaws.com/<pool-id>
    ```

    Using the localhost Ministack endpoint as the issuer will cause every token verification to fail with a 401, even if the token is otherwise valid.

## Proven authorizer configuration

This exact configuration produced a passing smoke test. Use it as the baseline for JE-28 (Cognito) and JE-30 (API Gateway).

| Parameter | Value |
|---|---|
| Issuer | `https://cognito-idp.us-east-1.amazonaws.com/<pool-id>` |
| Audience | App client ID |
| Identity source | `$request.header.Authorization` |
| Auth flows | `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH` |

## Related

- [[ADR-0012-ministack-local]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0009-apigw-alb-fargate]]
