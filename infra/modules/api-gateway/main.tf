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

# ─── nginx HTTP_PROXY Integration ────────────────────────────────────────────
#
# integration_uri is a placeholder (http://0.0.0.0:80/) until the JE-36
# bootstrap patches it with the nginx ECS task's actual private IP.
# See variable `nginx_integration_uri` for the bootstrap procedure.
# payload_format_version = "1.0" matches the spike.
#
# request_parameters — claim injection (ADR-0010 / ADR-0016):
#   Auth lives at the EDGE. The Cognito JWT authorizer validates the token;
#   the backend receives the caller's identity as a plain header — it must NOT
#   decode JWTs itself.
#
#   We inject the `email` claim (not `sub`) because:
#     - Our users table uses a nano-id (usr_*) as the primary key, not the
#       Cognito sub UUID, so `sub` cannot be used to look up a user directly.
#     - `email` exists in BOTH the Cognito IdToken and our users table, making
#       it the only JWT claim that maps 1-to-1 to a stored user without an
#       extra Cognito lookup.
#     - Ministack 1.3.69-full populates $context.authorizer.claims for HTTP_PROXY
#       integrations and forwards `append:header.*` request_parameters correctly
#       (verified in JE-37; logged in ministack-auth-chain-spike-findings).
#
#   Production parity: real AWS API GW v2 HTTP APIs support
#   $context.authorizer.claims.* identically. No production-only workaround needed.
resource "aws_apigatewayv2_integration" "nginx" {
  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = var.nginx_integration_uri

  payload_format_version = "1.0"

  # Inject the authenticated user's email as a backend header so the service
  # can identify the caller without decoding the JWT itself.
  request_parameters = {
    "append:header.x-user-id" = "$context.authorizer.claims.email"
  }
}

# ─── Public routes (no authorizer) ───────────────────────────────────────────

resource "aws_apigatewayv2_route" "register" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /v1/users/register"
  target    = "integrations/${aws_apigatewayv2_integration.nginx.id}"
}

resource "aws_apigatewayv2_route" "login" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /v1/users/login"
  target    = "integrations/${aws_apigatewayv2_integration.nginx.id}"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /v1/health"
  target    = "integrations/${aws_apigatewayv2_integration.nginx.id}"
}

# ─── Protected routes (JWT authorizer required) ───────────────────────────────

resource "aws_apigatewayv2_route" "get_me" {
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "GET /v1/users/me"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.nginx.id}"
}

resource "aws_apigatewayv2_route" "patch_me" {
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "PATCH /v1/users/me"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.nginx.id}"
}

# ─── E2E cleanup route ────────────────────────────────────────────────────────
#
# No authorizer: the service endpoint itself returns 404 when
# E2E_TESTING_ENABLED=false, so the route is safe at the infra level.
# Gated by var.enable_e2e_cleanup_route (default true) for flexibility.
resource "aws_apigatewayv2_route" "e2e_cleanup" {
  count = var.enable_e2e_cleanup_route ? 1 : 0

  api_id    = aws_apigatewayv2_api.this.id
  route_key = "DELETE /v1/users/e2e-cleanup"
  target    = "integrations/${aws_apigatewayv2_integration.nginx.id}"
}
