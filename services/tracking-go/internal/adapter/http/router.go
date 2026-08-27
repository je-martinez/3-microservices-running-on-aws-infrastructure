package http

import "github.com/gin-gonic/gin"

// NewRouter builds the Gin engine with the routes registered so far.
//
// ## Gin route trees PANIC AT STARTUP on a conflict
//
// Gin builds one radix route tree PER HTTP METHOD and panics when a wildcard and
// a literal collide within one method's tree. Starlette matched by declaration
// order and simply never reached the shadowed route, so this failure mode did
// not exist in the Python service.
//
// Today's literals are:
//
//	POST   /v1/trackings/init-tracking
//	DELETE /v1/trackings/by-user
//	DELETE /v1/trackings/e2e-cleanup
//
// None conflicts with GET /v1/trackings/:order_id BECAUSE THE METHODS DIFFER —
// they live in separate trees. But adding ANY GET literal under /v1/trackings/
// (e.g. GET /v1/trackings/summary) lands in the same tree as the :order_id
// wildcard and panics the process on boot. Whoever adds such a route must
// restructure the prefix, not merely register one more handler.
func NewRouter() *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())

	// Gin defaults this to false, which answers 404 for a path that exists under
	// a different method. The Python surface answers 405 — notably for the
	// unmounted e2e route — so the default would be a silent behavioural drift.
	router.HandleMethodNotAllowed = true

	RegisterHealth(router)

	return router
}
