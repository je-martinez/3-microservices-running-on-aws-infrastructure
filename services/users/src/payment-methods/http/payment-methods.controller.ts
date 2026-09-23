import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  UseInterceptors,
} from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AppConfigService } from "#config/config.module";
import type { CurrentUser } from "#shared/auth/current-user";
import { ZodValidationPipe } from "#shared/http/zod-validation.pipe";
import {
  AttachPaymentMethodInputSchema,
  PaymentMethodIdParamSchema,
} from "#features/payment-methods/http/schemas";
import { CurrentUserParam } from "../../users/http/current-user.decorator.ts";
import { CurrentUserInterceptor } from "../../users/http/current-user.interceptor.ts";
import { CreateSetupIntentCommand } from "../commands/create-setup-intent.command.ts";
import { AttachPaymentMethodCommand } from "../commands/attach-payment-method.command.ts";
import { DetachPaymentMethodCommand } from "../commands/detach-payment-method.command.ts";
import { SetDefaultPaymentMethodCommand } from "../commands/set-default-payment-method.command.ts";
import { ListPaymentMethodsQuery } from "../queries/list-payment-methods.query.ts";

const X_USER_ID = {
  name: "x-user-id",
  required: false,
  description:
    "Cognito subject forwarded by the API Gateway authorizer. Required in practice — " +
    "a request without it resolves no current user and is answered 404 (not a 400).",
} as const;

// CONTRACT: Transport only — bind the request, resolve the caller to their
// internal usr_ id, dispatch exactly one command/query, map its result. No
// Prisma or Stripe call belongs here. Do NOT mark any route @Public(): that
// absence is what makes AuthGuard 401 a request with no identity.
// See [[users-service-design]]
@ApiTags("payment-methods")
@Controller("v1/users/me/payment-methods")
@UseInterceptors(CurrentUserInterceptor)
export class PaymentMethodsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly config: AppConfigService,
  ) {}

  // CONTRACT: A miss here is the same "resolves to no user" case get-me.query.ts
  // handles at the query-handler level — this route's handlers take a plain
  // userId, so the resolution happens here instead. See [[soft-delete]]
  private async resolveUserId(currentUser: CurrentUser): Promise<string> {
    const user = await currentUser.resolve();
    if (!user) throw new NotFoundException({ error: "not_found" });
    return user.id;
  }

  private e2eSource(header: string | undefined): boolean {
    return header === "true" && this.config.get("E2E_TESTING_ENABLED", { infer: true });
  }

  @Post("setup-intent")
  @HttpCode(200)
  @ApiOperation({
    operationId: "createPaymentMethodSetupIntent",
    summary: "Create a SetupIntent to tokenize a new payment method",
  })
  @ApiHeader(X_USER_ID)
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/SetupIntentResult" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 503, schema: { $ref: "#/components/schemas/Error" } })
  async createSetupIntent(
    @CurrentUserParam() currentUser: CurrentUser,
    @Headers("x-e2e-source") e2eHeader: string | undefined,
  ) {
    const userId = await this.resolveUserId(currentUser);
    return this.commandBus.execute(
      new CreateSetupIntentCommand({ userId, e2eSource: this.e2eSource(e2eHeader) }),
    );
  }

  @Get()
  @ApiOperation({
    operationId: "listPaymentMethods",
    summary: "List the caller's saved payment methods",
    description: "Reads only the local table — never calls Stripe on this path.",
  })
  @ApiHeader(X_USER_ID)
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/PaymentMethodList" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  async list(@CurrentUserParam() currentUser: CurrentUser) {
    const userId = await this.resolveUserId(currentUser);
    return this.queryBus.execute(new ListPaymentMethodsQuery(userId));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: "attachPaymentMethod",
    summary: "Attach a tokenized payment method to the caller",
  })
  @ApiHeader(X_USER_ID)
  @ApiBody({ schema: { $ref: "#/components/schemas/AttachPaymentMethod" } })
  @ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/AttachPaymentMethodResult" } })
  @ApiResponse({ status: 402, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 403, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 503, schema: { $ref: "#/components/schemas/Error" } })
  async attach(
    @CurrentUserParam() currentUser: CurrentUser,
    @Body(new ZodValidationPipe(AttachPaymentMethodInputSchema))
    body: { paymentMethodId: string },
    @Headers("x-e2e-source") e2eHeader: string | undefined,
  ) {
    const userId = await this.resolveUserId(currentUser);
    return this.commandBus.execute(
      new AttachPaymentMethodCommand({
        userId,
        paymentMethodId: body.paymentMethodId,
        e2eSource: this.e2eSource(e2eHeader),
      }),
    );
  }

  // CONTRACT: `result !== "detached"` is the same RoutineFailure-unwrapping
  // pattern as deleteMe/updateMe in users.controller.ts — the handler returns a
  // discriminated string, never throws, for a routine "not found or not owned".
  // See [[cqrs]]
  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ operationId: "detachPaymentMethod", summary: "Detach a payment method" })
  @ApiHeader(X_USER_ID)
  @ApiParam({ name: "id", description: "Stripe PaymentMethod id (pm_...)" })
  @ApiResponse({ status: 204, description: "Default Response" })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 503, schema: { $ref: "#/components/schemas/Error" } })
  async detach(
    @CurrentUserParam() currentUser: CurrentUser,
    @Param(new ZodValidationPipe(PaymentMethodIdParamSchema)) params: { id: string },
  ): Promise<void> {
    const userId = await this.resolveUserId(currentUser);
    const result = await this.commandBus.execute(
      new DetachPaymentMethodCommand({ userId, paymentMethodId: params.id }),
    );
    if (result !== "detached") throw new NotFoundException({ error: "not_found" });
  }

  @Put(":id/default")
  @HttpCode(204)
  @ApiOperation({
    operationId: "setDefaultPaymentMethod",
    summary: "Set a payment method as the caller's default",
  })
  @ApiHeader(X_USER_ID)
  @ApiParam({ name: "id", description: "Stripe PaymentMethod id (pm_...)" })
  @ApiResponse({ status: 204, description: "Default Response" })
  @ApiResponse({ status: 404, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({ status: 503, schema: { $ref: "#/components/schemas/Error" } })
  async setDefault(
    @CurrentUserParam() currentUser: CurrentUser,
    @Param(new ZodValidationPipe(PaymentMethodIdParamSchema)) params: { id: string },
  ): Promise<void> {
    const userId = await this.resolveUserId(currentUser);
    const result = await this.commandBus.execute(
      new SetDefaultPaymentMethodCommand({ userId, paymentMethodId: params.id }),
    );
    if (result !== "set_default") throw new NotFoundException({ error: "not_found" });
  }
}
