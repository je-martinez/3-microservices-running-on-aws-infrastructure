// The opening line of every transactional email.
//
// `fullName` is routinely absent, and not as an edge case: Cognito populates no
// `name` attribute today (Users' AdminCreateUser writes only `email`,
// `email_verified` and `custom:app_user_id`), so AUTH_OTP_REQUESTED carries ""
// on every send. The other three events do carry a real name, but they reach
// their templates through `renderTemplate`, which erases props to `unknown` —
// so any of them can arrive nameless too.
//
// Interpolating directly (`Hi {fullName},`) renders "Hi ," — a space before an
// orphaned comma — which reads as a bug to the recipient. Dropping just the name
// gives "Hi,", which is only marginally better: a comma with nothing to
// separate.
//
// So the nameless case gets its own complete sentence rather than a trimmed
// version of the named one. "Hello," alone is a normal way to open a message;
// "Hi," alone is a fragment.
export function greeting(fullName?: string): string {
  const name = fullName?.trim();
  return name ? `Hi ${name},` : "Hello,";
}
