import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Post } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AppConfigService } from "#config/config.module";
import { Public } from "#shared/auth/public.decorator";
import {
  CaptureCognitoIdentityCommand,
  NoMatchingUserError,
} from "#features/users/webhooks/capture-cognito-identity";
import { cognitoWebhookPayloadSchema } from "#features/users/webhooks/cognito-payload";
import { verifyWebhookSecret } from "#features/users/webhooks/verify-secret";

// WARNING: PUBLIC at the API Gateway — no JWT authorizer. Its callers are the
// Cognito Lambda shim and the service itself, so the shared secret is its only
// guard. Keep the payload OUT of ZodValidationPipe: parse manually so an invalid
// payload answers 422 rather than the schema-validation 400.
@ApiTags("webhooks")
@Controller("v1/webhooks")
export class CognitoWebhookController {
  constructor(
    private readonly config: AppConfigService,
    private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand,
  ) {}

  @Post("cognito")
  @Public()
  @HttpCode(200)
  @ApiOperation({
    operationId: "cognitoWebhook",
    summary: "Cognito PostConfirmation trigger webhook",
  })
  @ApiHeader({
    name: "x-webhook-secret",
    required: false,
    description:
      "Shared secret guarding the Cognito webhook. Required in practice — a missing or wrong " +
      "value is rejected 401 by the handler (not schema-validated to a 400).",
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    },
  })
  @ApiResponse({ status: 401, schema: { $ref: "#/components/schemas/Error" } })
  @ApiResponse({
    status: 422,
    schema: {
      type: "object",
      properties: {
        error: { type: "string", enum: ["invalid_payload"] },
        details: { type: "array", items: {} },
      },
      required: ["error", "details"],
      additionalProperties: false,
    },
  })
  @ApiResponse({ status: 500, schema: { $ref: "#/components/schemas/Error" } })
  async cognito(
    @Headers("x-webhook-secret") secret: string | string[] | undefined,
    @Body() body: unknown,
  ) {
    const expected = this.config.get("WEBHOOK_SECRET", { infer: true });
    if (!verifyWebhookSecret(secret, expected)) {
      throw new HttpException({ error: "unauthorized" }, HttpStatus.UNAUTHORIZED);
    }

    const parsed = cognitoWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { error: "invalid_payload", details: parsed.error.issues },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      const { status } = await this.captureCognitoIdentityCommand.execute(parsed.data);
      return { status };
    } catch (err) {
      if (err instanceof NoMatchingUserError) {
        // CONTRACT: Answer 500, not 404/409 — a confirmed Cognito identity with no
        // users row is a server-side inconsistency, and Cognito retries the trigger
        // on a non-2xx so a transient race self-heals. See [[logging-context]]
        throw new HttpException({ error: "no_matching_user" }, HttpStatus.INTERNAL_SERVER_ERROR);
      }
      throw err;
    }
  }
}
