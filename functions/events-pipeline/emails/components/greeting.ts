// The opening line of every transactional email.
// CONTRACT: Handle the nameless case with its own sentence, never by trimming
// the named one. `fullName` is routinely absent — Cognito populates no `name`
// attribute, so AUTH_OTP_REQUESTED sends "" every time, and `renderTemplate`
// erases props to `unknown` so any template can arrive nameless. Interpolating
// directly renders "Hi ," to the recipient.
// See [[email-templates]]
export function greeting(fullName?: string): string {
  const name = fullName?.trim();
  return name ? `Hi ${name},` : "Hello,";
}
