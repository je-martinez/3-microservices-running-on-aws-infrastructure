// Pre-Token-Generation V2 trigger: copy the app_user_id custom attribute into
// an app_user_id claim on both the id and access tokens. No DB access — the id
// is read from the trigger event's userAttributes (set by register at sign-up).
export const handler = async (event) => {
  const appUserId = event.request.userAttributes["custom:app_user_id"];
  const claims = appUserId ? { app_user_id: appUserId } : {};
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
