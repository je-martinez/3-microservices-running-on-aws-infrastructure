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
// CONTRACT: Bare internally, PREFIXED at the gateway (/v1/tracking/health, which
// nginx rewrites down). A bare health route at the gateway falls through nginx's
// `location /` catch-all to users:3000 and returns USERS' 200 — a Tracking probe
// reporting healthy without ever reaching this service.
// See [[2026-08-25-route-works-in-process-but-404s-at-gateway]]
//
// CONTRACT: Unauthenticated and shallow. An ALB/Fargate probe carries no
// x-user-id and no API key, and folding a SELECT 1 in here makes a transient
// database blip cycle otherwise-healthy tasks. See [[health-check-logging]]
func RegisterHealth(router gin.IRouter) {
	router.GET("/v1/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, HealthResponse{Status: "ok"})
	})
}
