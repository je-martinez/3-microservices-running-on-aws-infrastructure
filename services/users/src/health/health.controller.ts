import { Controller, Get } from "@nestjs/common";
import { Public } from "#shared/auth/public.decorator";

// CONTRACT: Liveness only — it answers that the process is up, nothing more.
// The compose healthcheck and the E2E specs assert this exact body, so a
// readiness probe that also checked the database would restart containers that
// are serving fine. See [[health-check-logging]]
@Controller("v1/health")
export class HealthController {
  @Public()
  @Get()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
