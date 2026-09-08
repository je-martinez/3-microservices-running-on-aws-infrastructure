// Typed auth-domain errors. The HTTP layer's setErrorHandler maps these to
// status codes without ever touching the Cognito SDK's exception names (those
// stay in cognito-auth-provider.ts).
export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super("invalid credentials", 401, "invalid_credentials");
  }
}

// A wrong, expired or already-consumed one-time code. Distinct from
// InvalidCredentialsError only because the OTP flow is a separate surface with
// its own operational meaning — it leaks nothing about account existence: the
// caller already proved they hold a live challenge session to get here.
export class InvalidOtpError extends AuthError {
  constructor() {
    super("invalid or expired one-time code", 401, "invalid_otp");
  }
}

// CONTRACT: One error for a wrong, expired or consumed reset code AND for an email
// with no account at all — distinguishing them turns this endpoint into the
// enumeration oracle /password/forgot avoids. Separate from InvalidOtpError because a
// spike here is a reset-abuse signal, not a login one.
export class InvalidResetCodeError extends AuthError {
  constructor() {
    super("invalid or expired password reset code", 401, "invalid_reset_code");
  }
}

export class EmailAlreadyExistsError extends AuthError {
  constructor() {
    super("email already registered", 409, "email_exists");
  }
}
