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

export class EmailAlreadyExistsError extends AuthError {
  constructor() {
    super("email already registered", 409, "email_exists");
  }
}
