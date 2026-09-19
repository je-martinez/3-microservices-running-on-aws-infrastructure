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
  async login(
    @Body(new ZodValidationPipe(LoginInputSchema)) body: { email: string; password: string },
  ) {
    return this.commandBus.execute(new LoginCommand(body));
  }

  @Post("refresh")
  @Public()
  @HttpCode(200)
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
  async otpStart(@Body(new ZodValidationPipe(OtpStartInputSchema)) body: { email: string }) {
    return this.commandBus.execute(new StartOtpChallengeCommand(body));
  }

  @Post("otp/verify")
  @Public()
  @HttpCode(200)
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
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordInputSchema)) body: { email: string },
  ) {
    await this.commandBus.execute(new ForgotPasswordCommand(body));
    return { status: "accepted" as const };
  }

  @Post("password/confirm")
  @Public()
  @HttpCode(200)
  async confirmPassword(
    @Body(new ZodValidationPipe(ConfirmPasswordResetInputSchema))
    body: { email: string; code: string; newPassword: string },
  ) {
    await this.commandBus.execute(new ConfirmPasswordResetCommand(body));
    return { status: "password_updated" as const };
  }

  @Get("me")
  @UseInterceptors(MeCacheInterceptor)
  async me(@CurrentUserParam() currentUser: CurrentUser) {
    const user = await this.queryBus.execute(new GetMeQuery(currentUser));
    // CONTRACT: The handler returns null for a routine miss; the controller —
    // not the handler — is what turns it into the 404 the E2E specs assert.
    if (!user) throw new NotFoundException({ error: "not_found" });
    return serializeUser(user as User);
  }

  @Patch("me")
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
  async deleteMe(@CurrentUserParam() currentUser: CurrentUser): Promise<void> {
    const result = await this.commandBus.execute(new DeleteAccountCommand(currentUser));
    if (result !== "deleted") throw new NotFoundException({ error: "not_found" });
  }

  // CONTRACT: This endpoint sets the password and clears `mustChangePassword`,
  // nothing else. Keep it separate from PATCH /v1/users/me. See [[audit-fields]]
  @Patch("me/password")
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
