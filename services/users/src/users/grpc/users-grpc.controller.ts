import { Controller } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { status } from "@grpc/grpc-js";
import { QueryBus } from "@nestjs/cqrs";
import { appLogger } from "#shared/logging/app-logger";
import { withGrpcServerSpan } from "#shared/observability/grpc-tracing";
import { toGrpcAddress } from "#shared/grpc/address";
import { GetUserByIdQuery } from "../queries/get-user-by-id.query.ts";

@Controller()
export class UsersGrpcController {
  constructor(private readonly queryBus: QueryBus) {}

  // CONTRACT: The SERVER span stays MANUAL. The api-key interceptor's
  // ServerInterceptingCall consumes the metadata, so auto-instrumentation has an
  // empty map to read and creates no server span; the caller's context is
  // extracted there and is already active here. See [[ADR-0003-grpc-inter-service]]
  @GrpcMethod("Users", "GetUserById")
  async getUserById(data: { id: string }): Promise<Record<string, unknown>> {
    return withGrpcServerSpan("users.v1.Users/GetUserById", async () => {
      // The request id is a `usr_` id OR a Cognito sub — neither is PII, so it
      // is logged as given.
      const user = await this.queryBus.execute(new GetUserByIdQuery(data.id));

      if (!user) {
        // A miss is a routine outcome, not a thrown error, so the span status
        // stays OK and the outcomes are told apart by app_event/reason.
        appLogger.info(
          { app_event: "get_user_by_id_failed", reason: "user_not_found" },
          "gRPC GetUserById found no user",
        );
        throw new RpcException({ code: status.NOT_FOUND, message: "user not found" });
      }

      appLogger.info(
        { app_event: "get_user_by_id_succeeded", user_id: user.id },
        "gRPC GetUserById resolved",
      );
      // WARNING: `address` is PII — never log this response. See [[logging-context]]
      return {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
        cognito_sub: user.cognitoSub ?? "",
        address: toGrpcAddress(user.address),
      };
    });
  }
}
