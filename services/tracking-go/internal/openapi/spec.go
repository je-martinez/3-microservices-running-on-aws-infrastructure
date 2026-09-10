// Package openapi builds the OpenAPI document the routes describe and pins it
// against the committed contract in testdata/, which is the file consumers
// import. See [[openapi-specs]]
package openapi

// CONTRACT: Every header on this surface stays optional AT THE SCHEMA LEVEL and
// is rejected INSIDE the handler. A required header is answered 422 by the
// framework, and 401 is the documented behaviour.
func nullableString(title string) map[string]any {
	return map[string]any{
		"anyOf": []any{
			map[string]any{"type": "string"},
			map[string]any{"type": "null"},
		},
		"title": title,
	}
}

func header(name, title string) map[string]any {
	return map[string]any{
		"name":     name,
		"in":       "header",
		"required": false,
		"schema":   nullableString(title),
	}
}

func ref(name string) map[string]any {
	return map[string]any{"$ref": "#/components/schemas/" + name}
}

// description is a response with NO body schema.
//
// Not an oversight and not a shortcut: FastAPI emits exactly this for a response
// declared as `{"description": …}` with no `model`, which is how the Python
// declares every 401 and two of its 404s. Giving those a schema here would be a
// difference from the contract, so the shape is reproduced rather than improved.
func description(text string) map[string]any {
	return map[string]any{"description": text}
}

func jsonResponse(desc string, schema map[string]any) map[string]any {
	return map[string]any{
		"description": desc,
		"content": map[string]any{
			"application/json": map[string]any{"schema": schema},
		},
	}
}

func jsonRequestBody(schema map[string]any) map[string]any {
	return map[string]any{
		"required": true,
		"content": map[string]any{
			"application/json": map[string]any{"schema": schema},
		},
	}
}

// validationError is FastAPI's 422, declared identically on every route that has
// a body or a required query parameter.
func validationError() map[string]any {
	return jsonResponse("Validation Error", ref("HTTPValidationError"))
}

// BuildSpec returns the OpenAPI document the routes describe, written by hand
// because gin knows the method and path and NOTHING about status codes, bodies
// or auth — the 401s from middleware, the 404/409 from a handler, the 400s from
// the state machine. This file IS the declaration, and spec_test.go enumerates
// the route table against it.
//
// CONTRACT: Document-level metadata (title, servers, tags) belongs here, never
// in a post-generation patch of the YAML — that makes the file hand-maintained
// again. BuildSpec reads nothing and dials nothing, so its test runs even with
// no MySQL reachable. See [[openapi-specs]]
func BuildSpec() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title": "Tracking Service API",
			"description": "HTTP API for the 3MRAI Tracking microservice (FastAPI + Aurora MySQL). Three " +
				"distinct auth schemes, documented per route rather than globally: the user-scoped reads " +
				"and creation take the gateway-injected x-user-id header (which carries the Cognito sub, " +
				"not the internal usr_ id); the carrier status update takes its own external x-api-key; " +
				"health and the E2E cleanup take neither.",
			"version": "1.0.0",
		},
		"servers": []any{
			map[string]any{
				"url":         "http://localhost:3002",
				"description": "Local (docker compose / Floci)",
			},
		},
		"paths":      paths(),
		"components": map[string]any{"schemas": schemas()},
		"tags":       tags(),
	}
}

// paths mirrors the Python's REGISTRATION order, not alphabetical order: health,
// e2e-cleanup, init-tracking, by-user, the two reads, the carrier PUT. A map has
// no order in Go, but the generator sorts on output and the diff is key-based, so
// this comment is about where to LOOK rather than what gets emitted.
func paths() map[string]any {
	return map[string]any{
		// Served UNPREFIXED by the service. The gateway publishes it as
		// /v1/tracking/health; the service's own path is /v1/health and that is
		// what this document — the service's contract — describes.
		"/v1/health": map[string]any{
			"get": map[string]any{
				"tags":        []any{"health"},
				"summary":     "Liveness/readiness probe",
				"description": healthDescription,
				"operationId": "health_v1_health_get",
				"responses": map[string]any{
					"200": jsonResponse("Successful Response", ref("HealthResponse")),
				},
			},
		},

		"/v1/trackings/e2e-cleanup": map[string]any{
			"delete": map[string]any{
				"tags": []any{"e2e"},
				"summary": "[E2E] Soft-delete every tracking tagged 'E2E Source' " +
					"(only mounted when E2E_TESTING_ENABLED)",
				"description": e2eCleanupDescription,
				"operationId": "cleanup_v1_trackings_e2e_cleanup_delete",
				// No 401 and no 422: the route takes no auth and no body. Its
				// EXISTENCE is the guard, and the document describes it as
				// mounted because the contract should say the surface is there
				// and that a flag decides it.
				"responses": map[string]any{
					"200": jsonResponse("The tagged trackings are soft-deleted", ref("E2eCleanupResponse")),
				},
			},
		},

		"/v1/trackings/init-tracking": map[string]any{
			"post": map[string]any{
				"tags":        []any{"trackings"},
				"summary":     "Create the tracking for one of the caller's orders",
				"description": initTrackingDescription,
				"operationId": "init_tracking_v1_trackings_init_tracking_post",
				"parameters": []any{
					header("x-user-id", "X-User-Id"),
					header("x-test-mode", "X-Test-Mode"),
					header("x-e2e-source", "X-E2E-Source"),
				},
				"requestBody": jsonRequestBody(ref("InitTrackingRequest")),
				"responses": map[string]any{
					// WRAPPED under "tracking" — the reads are flat, and the
					// difference is observable by a shipped client.
					"201": jsonResponse("Successful Response", ref("InitTrackingResponse")),
					// From middleware. No framework can infer it.
					"401": description("Missing or empty x-user-id"),
					// NESTED bodies — the Python CODE's shape, not its spec's.
					// See allowlist.go: the generated Python spec says flat here
					// and is WRONG, because FastAPI cannot express
					// HTTPException(detail={...})'s wrapping.
					"404": jsonResponse("Users has no such user", ref("NestedErrorResponse")),
					"409": jsonResponse("The order already has a tracking", ref("NestedErrorResponse")),
					"422": validationError(),
				},
			},
		},

		"/v1/trackings/by-user": map[string]any{
			"delete": map[string]any{
				"tags":        []any{"internal"},
				"summary":     "[Internal] Soft-delete every tracking belonging to a user",
				"description": "Soft-delete the user's trackings and, through the FK, their history.",
				"operationId": "delete_trackings_by_user_v1_trackings_by_user_delete",
				"parameters":  []any{header("x-api-key", "X-Api-Key")},
				"requestBody": jsonRequestBody(ref("InternalDeleteByUserRequest")),
				"responses": map[string]any{
					"200": jsonResponse("The user's trackings and their history are soft-deleted",
						ref("InternalDeleteByUserResponse")),
					"401": description("Missing or invalid internal API key"),
					"422": validationError(),
					// CONTRACT: DECLARED even though the pinned spec omits it.
					// This is the cascade's leg, and a caller treating an
					// undocumented 500 as impossible leaves a user
					// half-deleted.
					"500": jsonResponse("The soft-delete failed", ref("ErrorResponse")),
				},
			},
		},

		"/v1/trackings": map[string]any{
			"get": map[string]any{
				"tags":        []any{"trackings"},
				"summary":     "Read several of the caller's trackings by order id",
				"description": listTrackingsDescription,
				"operationId": "get_trackings_v1_trackings_get",
				"parameters": []any{
					map[string]any{
						"name":     "order_ids",
						"in":       "query",
						"required": true,
						"schema": map[string]any{
							"type":        "string",
							"description": orderIDsDescription,
							"title":       "Order Ids",
						},
						"description": orderIDsDescription,
					},
					header("x-user-id", "X-User-Id"),
				},
				"responses": map[string]any{
					// {"trackings": [...]}, NEVER a bare array.
					"200": jsonResponse("Successful Response", ref("TrackingListResponse")),
					// From the handler's own cap check, after parsing to
					// DISTINCT non-empty ids.
					"400": description("More than 100 order_ids"),
					"401": description("Missing x-user-id (no caller identity)"),
					"422": validationError(),
				},
			},
		},

		"/v1/trackings/{order_id}": map[string]any{
			"get": map[string]any{
				"tags":        []any{"trackings"},
				"summary":     "Read one of the caller's trackings by order id",
				"description": getTrackingDescription,
				"operationId": "get_tracking_v1_trackings__order_id__get",
				"parameters": []any{
					pathOrderID(),
					header("x-user-id", "X-User-Id"),
				},
				"responses": map[string]any{
					// FLAT, unlike the 201.
					"200": jsonResponse("Successful Response", ref("TrackingResponse")),
					"401": description("Missing x-user-id (no caller identity)"),
					// One answer for "not there" and "not yours" — a 403 would
					// turn the route into an oracle for other people's order ids.
					"404": description("No such tracking, or it belongs to another user"),
					"422": validationError(),
				},
			},
		},

		"/v1/trackings/{order_id}/status": map[string]any{
			"put": map[string]any{
				"tags":        []any{"carrier"},
				"summary":     "Carrier status update (API-key authenticated)",
				"description": carrierDescription,
				"operationId": "update_status_v1_trackings__order_id__status_put",
				"parameters": []any{
					pathOrderID(),
					header("x-api-key", "X-Api-Key"),
				},
				"requestBody": jsonRequestBody(ref("UpdateStatusRequest")),
				"responses": map[string]any{
					"200": jsonResponse("Successful Response", ref("TrackingResponse")),
					// Shape C — flat WITH a top-level `reason`, and the only
					// place that shape occurs. Distinct from the 404: 400 means
					// the tracking exists and refused the move, so retrying the
					// same status will never help.
					"400": jsonResponse("Rejected status transition", ref("ErrorResponse")),
					"401": description("Missing or invalid carrier API key"),
					"404": description("No tracking for that order id"),
					"422": validationError(),
				},
			},
		},
	}
}

func pathOrderID() map[string]any {
	return map[string]any{
		"name":     "order_id",
		"in":       "path",
		"required": true,
		"schema": map[string]any{
			"type":        "string",
			"description": "The order's id",
			"title":       "Order Id",
		},
		"description": "The order's id",
	}
}

func tags() []any {
	return []any{
		map[string]any{"name": "health", "description": "Liveness"},
		map[string]any{"name": "trackings", "description": "Creation and the user-scoped reads (x-user-id)"},
		map[string]any{"name": "carrier", "description": "Carrier status updates (external x-api-key)"},
		map[string]any{"name": "e2e", "description": "Test-only routes (E2E_TESTING_ENABLED)"},
		map[string]any{"name": "internal", "description": "Service-to-service routes. Not published on the API Gateway; authenticated " +
			"with the shared internal key, never a user JWT."},
	}
}
