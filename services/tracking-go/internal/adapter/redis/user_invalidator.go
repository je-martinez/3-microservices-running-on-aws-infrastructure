package redis

import (
	"context"
	"log/slog"
)

// UserInvalidator adapts the package-level InvalidateUser to the narrow port the
// account-deletion cascade declares (app.UserCacheInvalidator).
//
// A tiny struct rather than a closure so the wiring in main.go names what it is,
// and so the gateway and logger are bound once at construction instead of being
// captured per call.
type UserInvalidator struct {
	gw  Gateway
	log *slog.Logger
}

// NewUserInvalidator binds the gateway and logger the sweep will use.
func NewUserInvalidator(gw Gateway, log *slog.Logger) *UserInvalidator {
	if log == nil {
		log = slog.Default()
	}
	return &UserInvalidator{gw: gw, log: log}
}

// InvalidateUser clears every cache entry belonging to the user — response
// entries under both identifiers plus the cognito_sub -> user_id mapping.
//
// CONTRACT: It returns NO error. The deletion has already committed, so a Redis
// outage escaping here tells Users the cascade did not happen when it did and
// fails the whole account deletion. Failures are logged by the gateway.
func (i *UserInvalidator) InvalidateUser(ctx context.Context, cognitoSub, userID string) {
	InvalidateUser(ctx, i.gw, i.log, cognitoSub, userID)
}
