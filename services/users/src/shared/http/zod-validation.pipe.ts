import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod/v4";

/**
 * Validates one parameter against a Zod schema.
 *
 * CONTRACT: The rejection body must match Fastify + fastify-type-provider-zod
 * byte for byte — `{ statusCode, code: "FST_ERR_VALIDATION", error: "Bad Request",
 * message }` — because the E2E suite asserts on that contract. See [[openapi-specs]]
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // WARNING: Field PATHS only. A raw Zod message echoes the rejected values,
    // and those include passwords and emails. See [[logging-context]]
    //
    // WHY: Fastify prefixes each issue with the schema location (`body/`) and
    // joins with `, ` — reproduce that shape, not Nest's default array message.
    throw new BadRequestException({
      statusCode: 400,
      code: "FST_ERR_VALIDATION",
      error: "Bad Request",
      message: result.error.issues
        .map((issue) => `body/${issue.path.join("/")} ${issue.message}`)
        .join(", "),
    });
  }
}
