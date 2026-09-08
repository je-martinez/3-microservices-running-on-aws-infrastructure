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
      # CONTRACT: Do NOT add the internal cascade routes this endpoint calls
      # (DELETE /v1/orders/by-user, /v1/trackings/by-user) to this map — they
      # authenticate with the shared internal key and must stay unreachable from
      # outside the network. No nginx `location` needed: /v1/users/me falls
      # under `location /`, which already proxies to Users.
      delete_me = { key = "DELETE /v1/users/me", path = "/v1/users/me", auth = true }

      # CONTRACT: Keep auth = false on all three — these are the routes a caller
      # uses to OBTAIN a token, so requiring one makes them unreachable.
      # otp/verify returns login's AuthTokens shape, so nothing downstream
      # distinguishes an OTP session from a password one.
      otp_start             = { key = "POST /v1/users/otp/start", path = "/v1/users/otp/start", auth = false }
      otp_verify            = { key = "POST /v1/users/otp/verify", path = "/v1/users/otp/verify", auth = false }
      register_passwordless = { key = "POST /v1/users/register/passwordless", path = "/v1/users/register/passwordless", auth = false }

      # CONTRACT: Keep auth = false on both — a user who forgot their password
      # holds no token. WARNING: Do NOT add a gateway-level response mapping
      # here; forgot answers identically for known and unknown emails, and a
      # mapping that differentiates them reintroduces user enumeration.
      password_forgot  = { key = "POST /v1/users/password/forgot", path = "/v1/users/password/forgot", auth = false }
      password_confirm = { key = "POST /v1/users/password/confirm", path = "/v1/users/password/confirm", auth = false }

      # WHY: auth = true, unlike the two above — this is the change-password
      # endpoint for a caller who already holds a token. The service also 401s
      # on a missing x-user-id, so both layers agree.
      patch_me_password = { key = "PATCH /v1/users/me/password", path = "/v1/users/me/password", auth = true }

      # WHY: Per-service health, prefixed. nginx rewrites each to the service's
      # unprefixed /v1/health.
      users_health  = { key = "GET /v1/users/health", path = "/v1/users/health", auth = false }
      orders_health = { key = "GET /v1/orders/health", path = "/v1/orders/health", auth = false }

      # Orders functional routes. The route key drives APIGW matching; `path`
      # is baked into the LOCAL per-route integration URI (Floci ignores it, but
      # a literal must still be a valid URL — no unsubstituted {order_id}).
      create_order = { key = "POST /v1/orders", path = "/v1/orders", auth = true }
      my_orders    = { key = "GET /v1/orders/my-orders", path = "/v1/orders/my-orders", auth = true }
      # CONTRACT: A path param MUST appear in the integration `path` too. Omit it
      # and Floci drops the id, so nginx sees `GET /v1/orders` and returns 405.
      # CONTRACT: camelCase, NOT snake_case. Floci builds a Java named-capturing
      # group from the param name and Java allows only [A-Za-z0-9] there;
      # `{order_id}` raises PatternSyntaxException and returns a Floci 500.
      # See [[floci-rds-apigw-limits]]
      get_order = { key = "GET /v1/orders/{orderId}", path = "/v1/orders/{orderId}", auth = true }

      # Products catalog (read-only, authenticated). nginx prefix-matches
      # /v1/products and forwards to orders:8080 (see nginx.conf).
      list_products = { key = "GET /v1/products", path = "/v1/products", auth = true }

      # CONTRACT: Keep all three auth = true. The cart is keyed off the caller's
      # x-user-id, so an anonymous cart has no owner; they are absent from
      # Orders' PublicRoutes.cs for the same reason.
      get_cart    = { key = "GET /v1/cart", path = "/v1/cart", auth = true }
      put_cart    = { key = "PUT /v1/cart", path = "/v1/cart", auth = true }
      delete_cart = { key = "DELETE /v1/cart", path = "/v1/cart", auth = true }
    },
    var.enable_e2e_cleanup_route ? {
      e2e_cleanup = { key = "DELETE /v1/users/e2e-cleanup", path = "/v1/users/e2e-cleanup", auth = false }
    } : {},

    # ─── Tracking routes ──────────────────────────────────────────────────────
    #
    # CONTRACT: Do NOT enable these without nginx's `tracking` upstream in the
    # same change. nginx's default `location /` sends anything unmatched to
    # users:3000, so a health probe returns Users' 200 and looks green.
    var.enable_tracking_routes ? {
      # CONTRACT: Keep this path PREFIXED. A bare /v1/health route falls to
      # nginx's default `location /` and reaches users:3000, so the probe
      # returns Users' 200 and looks green. nginx rewrites the prefix away.
      tracking_health = { key = "GET /v1/tracking/health", path = "/v1/tracking/health", auth = false }

      # CONTRACT: Route keys never contain a query string, so the key is the bare
      # path; `?order_ids=<csv>` passes through the integration untouched.
      list_trackings = { key = "GET /v1/trackings", path = "/v1/trackings", auth = true }

      # WHY: The sole way a tracking record is created — Tracking is REST-only.
      # auth = true because the caller is Orders propagating the end user's JWT;
      # identity arrives in the x-user-id header nginx injects from the claims.
      # CONTRACT: This static key is not shadowed by GET /v1/trackings/{orderId}
      # — route keys include the method and POST != GET.
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
