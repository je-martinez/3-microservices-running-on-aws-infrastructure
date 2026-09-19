import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

const X_USER_ID = {
  name: "x-user-id",
  required: false,
  description:
    "Cognito subject forwarded by the API Gateway authorizer. Required in practice — " +
    "a request without it resolves no current user and is answered 404 (not a 400).",
} as const;
import { AppConfigService } from "#config/config.module";
import { Public } from "#shared/auth/public.decorator";
import type { CurrentUser } from "#shared/auth/current-user";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { invalidateMeCache, MeCacheInterceptor } from "#shared/cache/me-cache.interceptor";
import { ZodValidationPipe } from "#shared/http/zod-validation.pipe";
import {
  ChangePasswordInputSchema,
  ConfirmPasswordResetInputSchema,
  ForgotPasswordInputSchema,
  LoginInputSchema,
  OtpStartInputSchema,
  OtpVerifyInputSchema,
  RefreshInputSchema,
  RegisterInputSchema,
  RegisterPasswordlessInputSchema,
  UpdateProfileInputSchema,
} from "#features/users/http/schemas";
import type { User } from "#features/users/domain/user";
import { LoginCommand } from "../commands/login.command.ts";
import { RegisterCommand } from "../commands/register.command.ts";
import { RegisterPasswordlessCommand } from "../commands/register-passwordless.command.ts";
import { RefreshCommand } from "../commands/refresh.command.ts";
import { SignOutCommand } from "../commands/sign-out.command.ts";
import { StartOtpChallengeCommand } from "../commands/start-otp-challenge.command.ts";
import { VerifyOtpChallengeCommand } from "../commands/verify-otp-challenge.command.ts";
import { ForgotPasswordCommand } from "../commands/forgot-password.command.ts";
import { ConfirmPasswordResetCommand } from "../commands/confirm-password-reset.command.ts";
import { UpdateProfileCommand } from "../commands/update-profile.command.ts";
import { ChangePasswordCommand } from "../commands/change-password.command.ts";
import { DeleteAccountCommand } from "../commands/delete-account.command.ts";
import { GetMeQuery } from "../queries/get-me.query.ts";
import { CurrentUserParam } from "./current-user.decorator.ts";
import { CurrentUserInterceptor } from "./current-user.interceptor.ts";
import { bearerToken, serializeUser } from "./serializers.ts";

@ApiTags("users")
@Controller("v1/users")
@UseInterceptors(CurrentUserInterceptor)
export class UsersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly config: AppConfigService,
    private readonly cacheGateway: CacheGateway,
  ) {}

  @Post("register")
  @Public()
  @HttpCode(201)
  @ApiOperation({ operationId: "registerUser", summary: "Register a new user" })
  @ApiBody({ schema: { $ref: "#/components/schemas/RegisterInput" } })
  @ApiResponse({ status: 201, schema: { $ref: "#/components/schemas/User" } })
  @ApiResponse({ status: 409, schema: { $ref: "#/components/schemas/Error" } })
  async register(
    @Body(new ZodValidationPipe(RegisterInputSchema))
    body: {
      email: string;
      password: string;
      fullName: string;
      address?: unknown;
      phoneNumber?: string;
    },
    @Headers("x-e2e-source") e2eHeader: string | undefined,
  ) {
    const e2eSource =
      e2eHeader === "true" && this.config.get("E2E_TESTING_ENABLED", { infer: true });
    const user = await this.commandBus.execute(
      new RegisterCommand({ ...body, e2eSource }),
    );
    return serializeUser(user as User);
  }

  @Post("register/passwordless")
  @Public()
  @HttpCode(201)
  @ApiOperation({
    operationId: "registerPasswordlessUser",
    summary: "Register a new passwordless user (OTP-only login)",
  })
  @ApiBody({ schema: { $ref: "#/components/schemas/RegisterPasswordlessInput" } })
  @ApiResponse({ status: 201, schema: { $ref: "#/components/schemas/User" } })
  @ApiResponse({ status: 409, schema: { $ref: "#/components/schemas/Error" } })
  async registerPasswordless(
    @Body(new ZodValidationPipe(RegisterPasswordlessInputSchema))
    body: {
      email: string;
      fullName: string;
      address?: unknown;
      phoneNumber?: string;
    },
    @Headers("x-e2e-source") e2eHeader: string | undefined,
  ) {
    const e2eSource =
      e2eHeader === "true" && this.config.get("E2E_TESTING_ENABLED", { infer: true });
    const user = await this.commandBus.execute(
      new RegisterPasswordlessCommand({ ...body, e2eSource }),
    );
    return serializeUser(user as User);
  }

  @Post("login")
  @Public()
  @HttpCode(200)
  @ApiOperation({ operationId: "loginUser", summary: "Log in and obtain tokens" })
  @ApiBody({ schema: { $ref: "#/components/schemas/LoginInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/AuthTokens" } })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  async login(
    @Body(new ZodValidationPipe(LoginInputSchema)) body: { email: string; password: string },
  ) {
    return this.commandBus.execute(new LoginCommand(body));
  }

  @Post("refresh")
  @Public()
  @HttpCode(200)
  @ApiOperation({
    operationId: "refreshToken",
    summary: "Exchange a refresh token for new id/access tokens",
  })
  @ApiBody({ schema: { $ref: "#/components/schemas/RefreshInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/RefreshedTokens" } })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  async refresh(
    @Body(new ZodValidationPipe(RefreshInputSchema)) body: { refreshToken: string },
  ) {
    return this.commandBus.execute(new RefreshCommand(body));
  }

  // CONTRACT: Read the token from the Authorization header, NOT a body field — a
  // body field could name a DIFFERENT session than the one that authenticated the
  // request. Do NOT mark this @Public(): that absence is what makes AuthGuard 401
  // a caller with no identity. See [[users-service-design]]
  @Post("logout")
  @HttpCode(204)
  @ApiOperation({
    operationId: "logoutUser",
    summary: "Revoke the caller's Cognito session",
    description:
      "Globally signs the caller out, invalidating the id, access and refresh tokens Cognito " +
      "issued to them. Idempotent: an already-revoked or expired token also answers 204, because " +
      "the session being gone is the requested outcome.",
  })
  @ApiHeader({
    name: "authorization",
    required: false,
    description:
      "Bearer <Cognito access token>. The same header the gateway authorizer reads; the access " +
      "token is what authorizes the revocation, so no body is needed.",
  })
  @ApiResponse({ status: 204, description: "Default Response" })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  async logout(@Headers("authorization") authorization: string | undefined): Promise<void> {
    const accessToken = bearerToken(authorization);
    // A caller past the guard holds an x-user-id but may still have sent no
    // parseable Bearer token. There is no token to revoke, so this cannot be a 204.
    if (!accessToken) {
      throw new HttpException({ error: "invalid_credentials" }, HttpStatus.UNAUTHORIZED);
    }
    await this.commandBus.execute(new SignOutCommand({ accessToken }));
  }

  @Post("otp/start")
  @Public()
  @HttpCode(200)
  @ApiOperation({
    operationId: "startOtpChallenge",
    summary: "Start an OTP login challenge (password or passwordless users)",
  })
  @ApiBody({ schema: { $ref: "#/components/schemas/OtpStartInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/OtpStartResponse" } })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  async otpStart(@Body(new ZodValidationPipe(OtpStartInputSchema)) body: { email: string }) {
    return this.commandBus.execute(new StartOtpChallengeCommand(body));
  }

  @Post("otp/verify")
  @Public()
  @HttpCode(200)
  @ApiOperation({
    operationId: "verifyOtpChallenge",
    summary: "Verify an OTP code and obtain tokens",
  })
  @ApiBody({ schema: { $ref: "#/components/schemas/OtpVerifyInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/AuthTokens" } })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  async otpVerify(
    @Body(new ZodValidationPipe(OtpVerifyInputSchema))
    body: { email: string; session: string; code: string },
  ) {
    return this.commandBus.execute(new VerifyOtpChallengeCommand(body));
  }

  // CONTRACT: ALWAYS 202 with a fixed body, even for an unknown email — a 404
  // here is a user-enumeration oracle. See [[users-service-design]]
  @Post("password/forgot")
  @Public()
  @HttpCode(202)
  @ApiOperation({
    operationId: "forgotPassword",
    summary: "Request a password reset code by email",
    description:
      "Always answers 202 with the same body, whether or not the email belongs to an account — " +
      "the response deliberately does not reveal which.",
  })
  @ApiBody({ schema: { $ref: "#/components/schemas/ForgotPasswordInput" } })
  @ApiResponse({ status: 202, schema: { $ref: "#/components/schemas/PasswordResetAccepted" } })
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordInputSchema)) body: { email: string },
  ) {
    await this.commandBus.execute(new ForgotPasswordCommand(body));
    return { status: "accepted" as const };
  }

  @Post("password/confirm")
  @Public()
  @HttpCode(200)
  @ApiOperation({
    operationId: "confirmPasswordReset",
    summary: "Confirm a password reset with the emailed code",
  })
  @ApiBody({ schema: { $ref: "#/components/schemas/ConfirmPasswordResetInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/PasswordResetConfirmed" } })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  async confirmPassword(
    @Body(new ZodValidationPipe(ConfirmPasswordResetInputSchema))
    body: { email: string; code: string; newPassword: string },
  ) {
    await this.commandBus.execute(new ConfirmPasswordResetCommand(body));
    return { status: "password_updated" as const };
  }

  @Get("me")
  @UseInterceptors(MeCacheInterceptor)
  @ApiOperation({ operationId: "getMe", summary: "Get the current user's profile" })
  @ApiHeader(X_USER_ID)
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/User" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  async me(@CurrentUserParam() currentUser: CurrentUser) {
    const user = await this.queryBus.execute(new GetMeQuery(currentUser));
    // CONTRACT: The handler returns null for a routine miss; the controller —
    // not the handler — is what turns it into the 404 the E2E specs assert.
    if (!user) throw new NotFoundException({ error: "not_found" });
    return serializeUser(user as User);
  }

  @Patch("me")
  @ApiOperation({ operationId: "updateMe", summary: "Update the current user's profile" })
  @ApiHeader(X_USER_ID)
  @ApiBody({ schema: { $ref: "#/components/schemas/UpdateProfileInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/User" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  async updateMe(
    @CurrentUserParam() currentUser: CurrentUser,
    @Body(new ZodValidationPipe(UpdateProfileInputSchema))
    body: { fullName?: string; address?: unknown; phoneNumber?: string },
  ) {
    const updated = await this.commandBus.execute(new UpdateProfileCommand(currentUser, body));
    if (!updated) throw new NotFoundException({ error: "not_found" });

    // CONTRACT: Invalidate AFTER the write persists, never before — a concurrent
    // read otherwise repopulates the OLD value and it stays stale for the full
    // 5 minutes. Both key halves must match the read path exactly.
    await invalidateMeCache(this.cacheGateway, currentUser.identity, (updated as User).id);

    return serializeUser(updated as User);
  }

  // CONTRACT: Do NOT mark this @Public() — that absence is the only thing making
  // AuthGuard 401 a request without x-user-id. 204 with no body: the deleted row
  // must not be echoed back. See [[soft-delete]]
  @Delete("me")
  @HttpCode(204)
  @ApiOperation({ operationId: "deleteMe", summary: "Delete the current user's account" })
  @ApiHeader(X_USER_ID)
  @ApiResponse({ status: 204, description: "Default Response" })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 502, schema: { $ref: "#/components/schemas/Error" } })
  async deleteMe(@CurrentUserParam() currentUser: CurrentUser): Promise<void> {
    const result = await this.commandBus.execute(new DeleteAccountCommand(currentUser));
    if (result !== "deleted") throw new NotFoundException({ error: "not_found" });
  }

  // CONTRACT: This endpoint sets the password and clears `mustChangePassword`,
  // nothing else. Keep it separate from PATCH /v1/users/me. See [[audit-fields]]
  @Patch("me/password")
  @ApiOperation({
    operationId: "changeMyPassword",
    summary: "Change the current user's password",
    description:
      "Sets a new password for the authenticated caller and clears mustChangePassword. " +
      "Accepts no other user fields — use PATCH /v1/users/me for profile changes.",
  })
  @ApiHeader(X_USER_ID)
  @ApiBody({ schema: { $ref: "#/components/schemas/ChangePasswordInput" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/User" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  async changePassword(
    @CurrentUserParam() currentUser: CurrentUser,
    @Body(new ZodValidationPipe(ChangePasswordInputSchema)) body: { newPassword: string },
  ) {
    const updated = await this.commandBus.execute(new ChangePasswordCommand(currentUser, body));
    if (!updated) throw new NotFoundException({ error: "not_found" });

    // CONTRACT: A password change must invalidate the profile cache. No password
    // is cached, but this command clears `mustChangePassword`, a field of the
    // cached GET /v1/users/me body.
    await invalidateMeCache(this.cacheGateway, currentUser.identity, (updated as User).id);

    return serializeUser(updated as User);
  }
}
