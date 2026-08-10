// Pre-Token-Generation V2 trigger: copy custom attributes into token claims on
// both the id and access tokens. No DB access — every value is read from the
// trigger event's userAttributes, which Cognito already has in hand.
//
// `app_user_id` is immutable, written once by register at sign-up.
//
// `must_change_password` is NOT immutable: Users keeps the durable truth in
// Postgres (users.must_change_password) and mirrors it onto
// custom:must_change_password whenever it changes, so this trigger can stay
// dependency-free. That mirroring is what makes the claim correct; a token
// minted between the Postgres write and the Cognito write would carry the old
// value until the next token is issued.
//
// The claim is ALWAYS emitted, unlike app_user_id, which is omitted when
// absent. A missing boolean claim is ambiguous to a consumer — it cannot tell
// "no forced change" from "this token predates the feature" — whereas `false`
// says exactly one thing. Anything other than the string "true" reads as false,
// so an unset attribute (accounts created before the attribute existed) is
// safely permissive rather than locking users out of a change they cannot make.
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
