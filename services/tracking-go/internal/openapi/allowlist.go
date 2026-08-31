package openapi

// AllowedDifferences is CLOSED and ENUMERATED.
//
// Every entry is a spec-generation artifact or a difference where the PYTHON SPEC
// disagrees with the PYTHON CODE — never a behavioural divergence between the two
// services. The acceptance criterion for this migration is "an empty diff EXCEPT
// this list", so an entry added to make a test pass is an entry that has moved the
// goalposts, and the list growing beyond these categories means the criterion is
// not met rather than newly satisfied.
//
// spec_test.go asserts a CAP on the length, so that failure is a test failure and
// not a judgement call somebody has to remember to make. It also asserts the two
// nested-error entries are PRESENT, so a future change cannot quietly make the Go
// handler serve the flat body "to match the spec" and then delete the entry that
// documented why it must not.
//
// A trailing "*" matches one path segment, and a pattern also covers everything
// below the node it names.
var AllowedDifferences = []AllowedDifference{
	{
		Path: "paths./v1/trackings/init-tracking.post.responses.404.content.application/json.schema",
		Justification: "THE PYTHON SPEC IS WRONG AND THE PYTHON CODE IS RIGHT. The handler raises " +
			"HTTPException(detail={\"detail\": ..., \"reason\": ...}), which FastAPI renders as " +
			"{\"detail\": {\"detail\": ..., \"reason\": ...}} -- NESTED. FastAPI's generator cannot " +
			"express that wrapping and emits the flat ErrorResponse instead. The Go declares " +
			"NestedErrorResponse, matching the body every deployed client has actually received. " +
			"Recorded here rather than reproduced, because reproducing it would mean changing the " +
			"Go handler to serve a body no running service has ever served.",
	},
	{
		Path: "paths./v1/trackings/init-tracking.post.responses.409.content.application/json.schema",
		Justification: "Same as the 404 above: the code nests, the generated spec says flat, and the " +
			"Go follows the code.",
	},
	{
		Path: "components.schemas.NestedErrorResponse",
		Justification: "A schema the Python document does not contain at all, because FastAPI never " +
			"generated one for the wrapped body. It is the named target of the two entries above; " +
			"without it those responses would have to inline their schema and the difference would " +
			"be harder to read, not smaller.",
	},
	{
		Path: "components.schemas.NestedErrorBody",
		Justification: "The inner object of NestedErrorResponse, absent from the Python document for " +
			"the same reason. Kept as its own schema rather than inlined so the nesting is visible " +
			"to a reader of the document.",
	},
	{
		Path: "paths./v1/trackings/by-user.delete.responses.500",
		Justification: "THE GO DECLARES A FAILURE THE PYTHON SERVES BUT NEVER DECLARED. The Python " +
			"handler re-raises the driver's error untouched and FastAPI answers 500; its generator " +
			"cannot see a status that nothing declares, which is the same blind spot that shipped " +
			"both reads without their 401. This is the account-deletion cascade's leg, and a caller " +
			"treating an undocumented 500 as impossible leaves a user half-deleted. Documenting a " +
			"real, served response is strictly more accurate than the Python spec; it adds no " +
			"behaviour.",
	},
}
