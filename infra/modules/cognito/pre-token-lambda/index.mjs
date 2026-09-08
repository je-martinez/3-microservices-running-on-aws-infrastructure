// Pre-Token-Generation V2 trigger: copy custom attributes into token claims on
// both the id and access tokens. No DB access — every value comes from the
// trigger event's userAttributes.
//
// CONTRACT: Always emit `must_change_password`, unlike app_user_id, which is
// omitted when absent. A missing boolean claim cannot tell a consumer "no
// forced change" from "this token predates the feature". Anything but the
// string "true" reads as false, so an unset attribute stays permissive rather
// than locking a user out of a change they cannot make. Postgres holds the
// durable truth and Users mirrors it here, which keeps this trigger
// dependency-free. See [[cognito-pre-token-lambda]]
export const handler = async (event) => {
  const attributes = event.request.userAttributes;
  const appUserId = attributes["custom:app_user_id"];
  const claims = {
    ...(appUserId ? { app_user_id: appUserId } : {}),
    must_change_password: attributes["custom:must_change_password"] === "true",
  };
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
