package openapi

// The component schemas.
//
// # Reproduced from the Python contract, INCLUDING its Pydantic artifacts
//
// Every `title` here is one Pydantic auto-derived from a field name, and no
// consumer branches on a title. They are kept anyway: dropping them would be a
// difference on every schema at once, and the allowlist would then be carrying an
// entry that hides thirteen real ones behind a wildcard. Copying them costs
// nothing and keeps the diff genuinely empty.
//
// # Two schemas here are NOT in the Python document, deliberately
//
// NestedErrorResponse and NestedErrorBody describe the body init-tracking's 404
// and 409 actually serve. The Python CODE raises
// HTTPException(detail={"detail": ..., "reason": ...}), which FastAPI renders as
// {"detail": {"detail": ..., "reason": ...}} -- nested. FastAPI's generator
// cannot express that wrapping and emits the flat ErrorResponse instead, so THE
// PYTHON SPEC IS WRONG THERE AND THE PYTHON CODE IS RIGHT. The Go handler matches
// the code, this document matches the Go handler, and allowlist.go records the
// difference from the spec rather than "fixing" the handler to match a body no
// deployed service has ever served.
//
// # What is absent, and must stay absent
//
// No response schema carries `shipping_address` (PII) or `cognito_sub`
// (identity). `datetime` is a plain `string` on both response schemas -- the wire
// value is isoformat() + "Z" with microsecond precision, and "" when absent. It
// is NOT `format: date-time`, which would tell a generated client to expect
// RFC3339 and to parse "" as an error, and it is NOT nullable, because the field
// is never null.

// schemas returns components.schemas.
func schemas() map[string]any {
	return map[string]any{
		"E2eCleanupResponse": map[string]any{
			"properties": map[string]any{
				"deleted": map[string]any{
					"type":  "integer",
					"title": "Deleted",
				},
			},
			"type": "object",
			"required": []any{
				"deleted",
			},
			"title": "E2eCleanupResponse",
			"description": "`200` payload of `DELETE /v1/trackings/e2e-cleanup`.\n" +
				"\n" +
				"One field, and it earns its place: \"the suite still sees its fixtures\" and\n" +
				"\"the cleanup matched nothing\" look identical from the harness's side, so a\n" +
				"bodiless `204` would leave it unable to tell a teardown that worked from one\n" +
				"that silently selected zero rows without reading this service's logs. Users'\n" +
				"cleanup returns its `count` for the same reason.\n" +
				"\n" +
				"Named `deleted` rather than `count` because it says what was counted.",
		},
		"ErrorResponse": map[string]any{
			"properties": map[string]any{
				"detail": map[string]any{
					"type":  "string",
					"title": "Detail",
				},
				"reason": map[string]any{
					"type":  "string",
					"title": "Reason",
				},
			},
			"type": "object",
			"required": []any{
				"detail",
				"reason",
			},
			"title": "ErrorResponse",
			"description": "Failure payload.\n" +
				"\n" +
				"`reason` is the machine-readable `TransitionRejectionReason`\n" +
				"(`already_delivered` / `backward_transition` / `not_strictly_forward`) or a\n" +
				"comparable code — the same value the `*_failed` log line carries, so a caller\n" +
				"debugging a rejection and an operator reading the logs see the same token.",
		},
		"HTTPValidationError": map[string]any{
			"properties": map[string]any{
				"detail": map[string]any{
					"items": map[string]any{
						"$ref": "#/components/schemas/ValidationError",
					},
					"type":  "array",
					"title": "Detail",
				},
			},
			"type":  "object",
			"title": "HTTPValidationError",
		},
		"HealthResponse": map[string]any{
			"properties": map[string]any{
				"status": map[string]any{
					"type":    "string",
					"title":   "Status",
					"default": "ok",
				},
			},
			"type":        "object",
			"title":       "HealthResponse",
			"description": "`GET /v1/health` — the exact body the design specifies.",
		},
		"InitTrackingRequest": map[string]any{
			"properties": map[string]any{
				"order_id": map[string]any{
					"type":        "string",
					"maxLength":   28,
					"minLength":   1,
					"title":       "Order Id",
					"description": "The order this tracking follows.",
				},
				"shipping_address": map[string]any{
					"anyOf": []any{
						map[string]any{
							"type": "object",
						},
						map[string]any{
							"type": "null",
						},
					},
					"title":       "Shipping Address",
					"description": "Point-in-time delivery address snapshot. Never logged (PII).",
				},
			},
			"additionalProperties": false,
			"type":                 "object",
			"required": []any{
				"order_id",
			},
			"title": "InitTrackingRequest",
			"description": "Body of `POST /v1/trackings/init-tracking` (JE-105).\n" +
				"\n" +
				"## Two fields, and deliberately no identity\n" +
				"\n" +
				"`order_id` and `shipping_address`, nothing else. The caller's identity is NOT\n" +
				"in the body and must never be: it arrives as the gateway-injected `x-user-id`\n" +
				"header, which the gateway derives from a verified Cognito JWT. A `user_id` (or\n" +
				"`cognito_sub`) field here would be an unauthenticated string a client chooses,\n" +
				"so anyone could create a tracking attributed to anyone — the body is client\n" +
				"input, the header is a gateway assertion. The service resolves the internal\n" +
				"`usr_` id itself, through Users, rather than believing a claim it was handed.\n" +
				"\n" +
				"## `test_mode` is not here either\n" +
				"\n" +
				"It travels as the `x-test-mode` header — see the router's docstring for why.\n" +
				"\n" +
				"`model_config` forbids extra fields: a client sending `user_id` gets a `422`\n" +
				"naming the field, rather than having it silently ignored and later wondering\n" +
				"why the tracking belongs to someone else.",
		},
		"InitTrackingResponse": map[string]any{
			"properties": map[string]any{
				"tracking": map[string]any{
					"$ref": "#/components/schemas/TrackingResponse",
				},
			},
			"type": "object",
			"required": []any{
				"tracking",
			},
			"title": "InitTrackingResponse",
			"description": "`201` payload: the created tracking, at `PLACED`, with its first history row.\n" +
				"\n" +
				"Reuses `TrackingResponse`'s shape rather than declaring a leaner one, so the\n" +
				"body a client gets from creating a tracking is identical to the one it gets\n" +
				"from reading it back — including the deliberate omissions (`shipping_address`\n" +
				"and `cognito_sub` are PII/identity and appear on neither).",
		},
		"InternalDeleteByUserRequest": map[string]any{
			"properties": map[string]any{
				"cognito_sub": map[string]any{
					"type":      "string",
					"minLength": 1,
					"title":     "Cognito Sub",
				},
				"user_id": map[string]any{
					"type":      "string",
					"minLength": 1,
					"title":     "User Id",
				},
			},
			"type": "object",
			"required": []any{
				"cognito_sub",
				"user_id",
			},
			"title":       "InternalDeleteByUserRequest",
			"description": "Body of `DELETE /v1/trackings/by-user`. Both identities are required.",
		},
		"InternalDeleteByUserResponse": map[string]any{
			"properties": map[string]any{
				"deleted": map[string]any{
					"type":  "integer",
					"title": "Deleted",
				},
			},
			"type": "object",
			"required": []any{
				"deleted",
			},
			"title": "InternalDeleteByUserResponse",
			"description": "`200` payload of `DELETE /v1/trackings/by-user`.\n" +
				"\n" +
				"Named `deleted` rather than `count` because it says what was counted — the same\n" +
				"shape Users and Orders report.",
		},
		"TrackingHistoryEntryResponse": map[string]any{
			"properties": map[string]any{
				"tracking_id": map[string]any{
					"type":  "string",
					"title": "Tracking Id",
				},
				"user_id": map[string]any{
					"type":  "string",
					"title": "User Id",
				},
				"order_id": map[string]any{
					"type":  "string",
					"title": "Order Id",
				},
				"status": map[string]any{
					"type":  "string",
					"title": "Status",
				},
				"datetime": map[string]any{
					"type":        "string",
					"title":       "Datetime",
					"description": "ISO-8601 UTC timestamp of this transition",
				},
			},
			"type": "object",
			"required": []any{
				"tracking_id",
				"user_id",
				"order_id",
				"status",
				"datetime",
			},
			"title": "TrackingHistoryEntryResponse",
			"description": "One immutable status transition.\n" +
				"\n" +
				"Carries no `shipping_address` — the address is fixed for a tracking's\n" +
				"lifetime, so only the tracking itself would hold it (and this surface does not\n" +
				"expose it at all).",
		},
		"TrackingListResponse": map[string]any{
			"properties": map[string]any{
				"trackings": map[string]any{
					"items": map[string]any{
						"$ref": "#/components/schemas/TrackingResponse",
					},
					"type":  "array",
					"title": "Trackings",
				},
			},
			"type": "object",
			"required": []any{
				"trackings",
			},
			"title": "TrackingListResponse",
			"description": "The batch read's payload.\n" +
				"\n" +
				"An object with a `trackings` list rather than a bare top-level array: a bare\n" +
				"array is not extensible (there is nowhere to add a field later without a\n" +
				"breaking change) and is the shape most REST clients handle worst.\n" +
				"\n" +
				"There is no `total`, and no per-id error entry. Non-owned and unknown ids are\n" +
				"silently omitted per the design's ownership rule, so a count of what came back\n" +
				"is exactly `len(trackings)` and anything more would start describing what the\n" +
				"caller does NOT own.",
		},
		"TrackingResponse": map[string]any{
			"properties": map[string]any{
				"id": map[string]any{
					"type":  "string",
					"title": "Id",
				},
				"user_id": map[string]any{
					"type":  "string",
					"title": "User Id",
				},
				"order_id": map[string]any{
					"type":  "string",
					"title": "Order Id",
				},
				"status": map[string]any{
					"type":  "string",
					"title": "Status",
				},
				"datetime": map[string]any{
					"type":        "string",
					"title":       "Datetime",
					"description": "ISO-8601 UTC timestamp of the current status",
				},
				"history": map[string]any{
					"items": map[string]any{
						"$ref": "#/components/schemas/TrackingHistoryEntryResponse",
					},
					"type":  "array",
					"title": "History",
				},
			},
			"type": "object",
			"required": []any{
				"id",
				"user_id",
				"order_id",
				"status",
				"datetime",
				"history",
			},
			"title": "TrackingResponse",
			"description": "A tracking together with its ordered history.\n" +
				"\n" +
				"History is part of the payload rather than a separate endpoint because every\n" +
				"caller of these reads wants both — the design specifies the tracking \"+ its\n" +
				"`Tracking_History`\" for the single read and for the batch read alike.",
		},
		"UpdateStatusRequest": map[string]any{
			"properties": map[string]any{
				"status": map[string]any{
					"type":  "string",
					"title": "Status",
				},
			},
			"type": "object",
			"required": []any{
				"status",
			},
			"title": "UpdateStatusRequest",
			"description": "Body of `PUT /v1/trackings/{order_id}/status`.\n" +
				"\n" +
				"`status` is validated as a *string* here and parsed into `TrackingStatus` in\n" +
				"the handler via `parse_status`. Declaring it as the enum would let Pydantic\n" +
				"reject an unknown value with a 422 before the handler ran — but the design\n" +
				"specifies `400` for a rejected status, and routing invalid-value handling\n" +
				"through one place keeps the four failure reasons (unknown value plus the three\n" +
				"transition guards) answering with the same status code and shape.",
		},
		"ValidationError": map[string]any{
			"properties": map[string]any{
				"loc": map[string]any{
					"items": map[string]any{
						"anyOf": []any{
							map[string]any{
								"type": "string",
							},
							map[string]any{
								"type": "integer",
							},
						},
					},
					"type":  "array",
					"title": "Location",
				},
				"msg": map[string]any{
					"type":  "string",
					"title": "Message",
				},
				"type": map[string]any{
					"type":  "string",
					"title": "Error Type",
				},
			},
			"type": "object",
			"required": []any{
				"loc",
				"msg",
				"type",
			},
			"title": "ValidationError",
		},

		// --- Not in the Python document. See the package comment above. ---
		"NestedErrorBody": map[string]any{
			"properties": map[string]any{
				"detail": map[string]any{
					"type":  "string",
					"title": "Detail",
				},
				"reason": map[string]any{
					"type":  "string",
					"title": "Reason",
				},
			},
			"type": "object",
			"required": []any{
				"detail",
				"reason",
			},
			"title": "NestedErrorBody",
			"description": "The inner object of `NestedErrorResponse`.\n" +
				"\n" +
				"Field-for-field identical to `ErrorResponse`, and a SEPARATE schema on\n" +
				"purpose: the two occupy different positions on the wire (`ErrorResponse` is\n" +
				"the whole body of the carrier 400, this one sits under `detail`), so sharing\n" +
				"a name would make the nesting invisible to anyone reading the document.",
		},
		"NestedErrorResponse": map[string]any{
			"properties": map[string]any{
				"detail": map[string]any{
					"$ref": "#/components/schemas/NestedErrorBody",
				},
			},
			"type": "object",
			"required": []any{
				"detail",
			},
			"title": "NestedErrorResponse",
			"description": "The body `POST /v1/trackings/init-tracking` serves on 404 and 409.\n" +
				"\n" +
				"NESTED, and the only place on this surface that shape occurs: the detail is\n" +
				"an OBJECT carrying its own `detail` and `reason`, not a string. The Python\n" +
				"raises `HTTPException(detail={\"detail\": ..., \"reason\": ...})` and FastAPI\n" +
				"wraps a structured detail this way, so this is what every deployed client has\n" +
				"always received -- even though the generated Python spec declares a flat\n" +
				"`ErrorResponse` here, because FastAPI cannot express the wrapping.",
		},
	}
}
