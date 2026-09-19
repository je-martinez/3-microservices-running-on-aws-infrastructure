import { Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Query } from "@nestjs/common";
import { Public } from "#shared/auth/public.decorator";
import { E2eCleanupCommand } from "#features/users/http/e2e-cleanup";
import { E2eIdentityQuery } from "#features/users/http/e2e-identity";

// Registered only when E2E_TESTING_ENABLED — see UsersModule. The cleanup route
// is @Public() so the harness teardown (no user session) can delete by tag.
@Controller("v1/users")
export class E2eController {
  constructor(
    private readonly e2eCleanupCommand: E2eCleanupCommand,
    private readonly e2eIdentityQuery: E2eIdentityQuery,
  ) {}

  @Delete("e2e-cleanup")
  @Public()
  @HttpCode(200)
  async cleanup() {
    const { count } = await this.e2eCleanupCommand.execute();
    return { deleted: count };
  }

  @Get("e2e-identity")
  @HttpCode(200)
  async identity(@Query("email") email: string | undefined) {
    if (!email) {
      throw new HttpException({ error: "email_required" }, HttpStatus.BAD_REQUEST);
    }
    return this.e2eIdentityQuery.execute(email);
  }
}
