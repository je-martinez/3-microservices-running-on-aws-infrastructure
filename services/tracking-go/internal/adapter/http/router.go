package http

import "github.com/gin-gonic/gin"

// NewRouter builds the Gin engine with the routes registered so far.
//
// CONTRACT: Do NOT add a GET literal under /v1/trackings/. Gin builds one radix
// tree per method and PANICS ON BOOT when a literal collides with the :order_id
// wildcard. Today's literals are POST/DELETE, so they live in other trees; such
// a route needs a restructured prefix. See [[openapi-specs]]
func NewRouter() *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())

	// CONTRACT: Keep this true. Gin's default answers 404 for a path that exists
	// under a different method; this surface's contract is 405, notably for the
	// unmounted e2e route. See [[openapi-specs]]
	router.HandleMethodNotAllowed = true

	RegisterHealth(router)

	return router
}
