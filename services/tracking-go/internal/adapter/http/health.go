package http

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// HealthResponse is the entire body of the liveness probe: {"status":"ok"}.
type HealthResponse struct {
	Status string `json:"status"`
}

// RegisterHealth mounts GET /v1/health.
//
// ## Bare path here, prefixed at the gateway
//
// The service serves this UNPREFIXED at /v1/health, while the gateway publishes
// it as /v1/tracking/health and nginx rewrites the prefixed path down to this
// bare one (infra/modules/compute/nginx/nginx.conf, marked HEALTH-ONLY there —
// the rewrite must not be extended to functional routes). Users and Orders serve
// theirs the same way.
//
// The gateway prefix is not cosmetic. nginx's default `location /` proxies
// anything unmatched to users:3000, so a bare GET /v1/health route AT THE
// GATEWAY would fall through to that catch-all and return USERS' 200 — a
// Tracking health probe that reports healthy while never once reaching this
// service. That failure mode is worse than a 404 because nothing would ever
// flag it. Hence: bare internally, prefixed at the gateway.
//
// ## Unauthenticated, and shallow
//
// No x-user-id, no API key — an ALB/Fargate probe carries neither. And it does
// NOT touch the database: this is a liveness check answering "is this process up
// and serving HTTP". Folding a SELECT 1 into it would make a transient database
// blip cycle otherwise-healthy tasks.
func RegisterHealth(router gin.IRouter) {
	router.GET("/v1/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, HealthResponse{Status: "ok"})
	})
}
