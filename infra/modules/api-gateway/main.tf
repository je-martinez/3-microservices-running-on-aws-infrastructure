# ─── HTTP API ─────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_api" "this" {
  name          = "${var.context.id}-api"
  protocol_type = "HTTP"
  tags          = var.context.tags
}

# ─── Default stage (auto-deploy) ─────────────────────────────────────────────
#
# auto_deploy = true matches the spike config and eliminates a manual deployment
# step on every route change.  Local invoke URL form:
#   http://<api-id>.execute-api.localhost:4566
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  tags        = var.context.tags
}

# ─── JWT Authorizer (Cognito) ─────────────────────────────────────────────────
#
# Issuer must be the AWS-format URL — NOT http://localhost:4566/<pool-id>.
# Ministack validates tokens against the AWS-format issuer even for local stacks.
# Proven in the spike (aws_apigatewayv2_authorizer.spike).
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.context.id}-jwt"

  jwt_configuration {
    audience = [var.cognito_audience]
    issuer   = var.cognito_issuer
  }
}

# ─── Route table (single source of truth) ────────────────────────────────────
#
# Floci drops the request path in HTTP_PROXY integrations (verified: it parses
# IntegrationUri as a literal URL and ignores $request.path / {proxy}). So in
# local mode we create ONE integration per route with the path baked into the
# URI. Real AWS preserves the path, so prod keeps a single shared integration.
locals {
  routes = merge(
    {
      register = { key = "POST /v1/users/register", path = "/v1/users/register", auth = false }
      login    = { key = "POST /v1/users/login", path = "/v1/users/login", auth = false }
      refresh  = { key = "POST /v1/users/refresh", path = "/v1/users/refresh", auth = false }
      get_me   = { key = "GET /v1/users/me", path = "/v1/users/me", auth = true }
      patch_me = { key = "PATCH /v1/users/me", path = "/v1/users/me", auth = true }

      # Passwordless email-OTP auth. `auth = false` on all three for the same
      # reason login and register carry it: these are the routes a caller uses to
      # OBTAIN a token, so requiring one would make them unreachable.
      #
      # otp/verify returns the identical AuthTokens shape as login, so nothing
      # downstream of the gateway (the JWT authorizer, the app_user_id claim)
      # distinguishes a session started by password from one started by OTP.
      #
      # No path params here, so the camelCase rule documented on get_order below
      # does not apply — but note it if these ever gain one.
      otp_start             = { key = "POST /v1/users/otp/start", path = "/v1/users/otp/start", auth = false }
      otp_verify            = { key = "POST /v1/users/otp/verify", path = "/v1/users/otp/verify", auth = false }
      register_passwordless = { key = "POST /v1/users/register/passwordless", path = "/v1/users/register/passwordless", auth = false }

      # Self-owned password reset. `auth = false` on both halves for the reason
      # login/register/otp carry it: a user who has forgotten their password
      # holds no token, so requiring one would make the flow unreachable.
      #
      # The forgot endpoint answers identically for a known and an unknown email
      # (no user enumeration) — nothing at this layer changes that, but do not
      # add a gateway-level response mapping that could.
      password_forgot  = { key = "POST /v1/users/password/forgot", path = "/v1/users/password/forgot", auth = false }
      password_confirm = { key = "POST /v1/users/password/confirm", path = "/v1/users/password/confirm", auth = false }

      # The AUTHENTICATED sibling — `auth = true`, unlike the two above. This is
      # the dedicated change-password endpoint for a caller who already holds a
      # token; the service also 401s it on a missing x-user-id, so the two layers
      # agree.
      patch_me_password = { key = "PATCH /v1/users/me/password", path = "/v1/users/me/password", auth = true }

      # Per-service health (replaces the bare GET /v1/health, which used to hit
      # Users only). nginx rewrites each to the service's unprefixed /v1/health.
      users_health  = { key = "GET /v1/users/health", path = "/v1/users/health", auth = false }
      orders_health = { key = "GET /v1/orders/health", path = "/v1/orders/health", auth = false }

      # Orders functional routes. The route key drives APIGW matching; `path`
      # is baked into the LOCAL per-route integration URI (Floci ignores it, but
      # a literal must still be a valid URL — no unsubstituted {order_id}).
      create_order = { key = "POST /v1/orders", path = "/v1/orders", auth = true }
      my_orders    = { key = "GET /v1/orders/my-orders", path = "/v1/orders/my-orders", auth = true }
      # {orderId} is an APIGW path param. It MUST appear in the integration `path`
      # too: Floci substitutes `{orderId}` in the integration URI with the real
      # request value (verified live — a request to /v1/orders/ord_X reaches nginx
      # as /v1/orders/ord_X). Baking only /v1/orders here dropped the id, so nginx
      # saw `GET /v1/orders` — which Orders only serves for POST (create) — and
      # returned 405. Real AWS preserves the path natively, so this form works in
      # both.
      #
      # camelCase, NOT snake_case: Floci builds a Java regex named-capturing
      # group from the param name (`(?<orderId>[^/]+)`), and Java only allows
      # [A-Za-z0-9] in group names — `{order_id}` produced
      # `(?<order_id>...)` → PatternSyntaxException ("named capturing group is
      # missing trailing '>'"), returning a Floci 500.
      get_order = { key = "GET /v1/orders/{orderId}", path = "/v1/orders/{orderId}", auth = true }

      # Products catalog (read-only, authenticated). nginx prefix-matches
      # /v1/products and forwards to orders:8080 (see nginx.conf).
      list_products = { key = "GET /v1/products", path = "/v1/products", auth = true }
    },
    var.enable_e2e_cleanup_route ? {
      e2e_cleanup = { key = "DELETE /v1/users/e2e-cleanup", path = "/v1/users/e2e-cleanup", auth = false }
    } : {},

    # ─── Tracking routes ──────────────────────────────────────────────────────
    #
    # Gated behind var.enable_tracking_routes (default FALSE) because the
    # Tracking service does not exist yet: `services/tracking/src/` is empty and
    # its Dockerfile is fully commented out. Creating these routes while nginx
    # has no `tracking` upstream would publish gateway paths that resolve to the
    # WRONG backend (nginx's default `location /` sends anything unmatched to
    # users:3000), which is worse than a 404 — a health probe would return
    # Users' 200 and look green. Flip the flag on in the same change that adds
    # the nginx upstream and a running service.
    #
    # This differs from enable_e2e_cleanup_route (default true) on purpose: that
    # route's backend already exists and the service itself 404s when disabled,
    # so it is safe to leave present. Here the backend is the thing that's
    # missing, so the gate has to live at the infra level.
    var.enable_tracking_routes ? {
      # Unauthenticated liveness probe, PREFIXED at the gateway like the other
      # services (/v1/users/health, /v1/orders/health). The service still serves
      # /v1/health unprefixed internally; nginx rewrites the prefixed path to the
      # bare one, health-only. A bare /v1/health route here would be worse than
      # wrong: nginx's default `location /` sends anything unmatched to
      # users:3000, so the probe would return Users' 200 and look green.
      tracking_health = { key = "GET /v1/tracking/health", path = "/v1/tracking/health", auth = false }

      # User-scoped batch read. API Gateway route keys NEVER contain a query
      # string, so the key is the bare path; `?order_ids=<csv>` is carried
      # through by the HTTP_PROXY integration untouched.
      list_trackings = { key = "GET /v1/trackings", path = "/v1/trackings", auth = true }

      # Tracking creation. Tracking is REST-only and serves no gRPC, so this is
      # the sole way a tracking record comes into existence. Body carries
      # `order_id` + `shipping_address`;
      # the caller's identity comes from the `x-user-id` header nginx injects
      # from the JWT claims (ADR-0016), so nothing user-scoped is in the path.
      # auth = true: the caller is Orders propagating the end user's JWT, so the
      # request always carries a Cognito token and goes through the existing JWT
      # authorizer — exactly like the read routes below.
      #
      # Static path, deliberately placed BEFORE get_tracking in this map for
      # readability only (map order is irrelevant to APIGW matching). It cannot
      # be shadowed by `GET /v1/trackings/{orderId}`: route keys include the
      # method, and POST != GET, so the two keys never compete. If a GET on this
      # same static path were ever added, APIGW v2 precedence would still favour
      # the static segment over the `{orderId}` variable one — but that is a
      # rule to rely on knowingly, not by accident.
      init_tracking = { key = "POST /v1/trackings/init-tracking", path = "/v1/trackings/init-tracking", auth = true }

      # User-scoped single read. camelCase path param, NOT snake_case: Floci
      # builds a Java named-capturing group from the param name and Java only
      # allows [A-Za-z0-9] in group names — `{order_id}` throws
      # PatternSyntaxException and returns a Floci 500 (same reason as
      # get_order above). The service reads it positionally, so the gateway-side
      # spelling is free to differ from the spec's `{order_id}`.
      get_tracking = { key = "GET /v1/trackings/{orderId}", path = "/v1/trackings/{orderId}", auth = true }

      # Carrier webhook. auth = FALSE deliberately: the caller is an external
      # carrier, not a Cognito user, so there is no JWT authorizer and therefore
      # no gateway-injected x-user-id on this request. The Tracking service
      # validates its own custom API key (a DIFFERENT secret from the internal
      # gRPC x-api-key). Follows the enable_e2e_cleanup_route precedent for a
      # no-authorizer route.
      update_tracking_status = { key = "PUT /v1/trackings/{orderId}/status", path = "/v1/trackings/{orderId}/status", auth = false }
    } : {}
  )
}

# ─── Integrations ─────────────────────────────────────────────────────────────

# LOCAL: one HTTP_PROXY integration per route, path baked into the URI.
resource "aws_apigatewayv2_integration" "per_route" {
  for_each = var.local_gateway ? local.routes : {}

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "${var.nginx_base_uri}${each.value.path}"
  payload_format_version = "1.0"
}

# PROD: single shared HTTP_PROXY integration (real AWS preserves the path).
resource "aws_apigatewayv2_integration" "shared" {
  count = var.local_gateway ? 0 : 1

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = var.nginx_integration_uri
  payload_format_version = "1.0"
}

# ─── Routes ───────────────────────────────────────────────────────────────────
resource "aws_apigatewayv2_route" "this" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.key
  target = var.local_gateway ? (
    "integrations/${aws_apigatewayv2_integration.per_route[each.key].id}"
    ) : (
    "integrations/${aws_apigatewayv2_integration.shared[0].id}"
  )

  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.jwt.id : null
}
