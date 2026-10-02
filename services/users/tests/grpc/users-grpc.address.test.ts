import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { type INestMicroservice, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type MicroserviceOptions } from "@nestjs/microservices";
import { QueryBus } from "@nestjs/cqrs";
import { grpcMicroserviceOptions } from "../../src/users/grpc/grpc-options.ts";
import { UsersGrpcController } from "../../src/users/grpc/users-grpc.controller.ts";

// WHY: A real server, client and proto rather than an assertion on the
// controller's return value — a dropped or misspelled field is only visible
// after proto serialization. See [[mocks-hide-schema-bugs]]
const PROTO = resolve(import.meta.dirname, "../../../../proto/users.proto");
const API_KEY = "test-grpc-key";
// Distinct from users-grpc.test.ts's port: vitest runs spec files in parallel.
const PORT = 50098;

const queryBus = { execute: vi.fn() };

@Module({
  controllers: [UsersGrpcController],
  providers: [{ provide: QueryBus, useValue: queryBus }],
})
class GrpcAddressTestModule {}

interface WireAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
}

describe("GetUserById address on the wire", () => {
  let app: INestMicroservice;
  let client: grpc.Client & Record<string, CallableFunction>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GrpcAddressTestModule] }).compile();
    app = moduleRef.createNestMicroservice<MicroserviceOptions>(
      grpcMicroserviceOptions({ GRPC_PORT: PORT, INTERNAL_API_KEY: API_KEY } as never),
    );
    await app.listen();

    const pkg = grpc.loadPackageDefinition(
      protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true }),
    ) as unknown as { users: { v1: { Users: grpc.ServiceClientConstructor } } };
    client = new pkg.users.v1.Users(
      `127.0.0.1:${PORT}`,
      grpc.credentials.createInsecure(),
    ) as grpc.Client & Record<string, CallableFunction>;
  });

  afterAll(async () => {
    client.close();
    await app.close();
  });

  function callWithStoredAddress(address: unknown): Promise<{ address: WireAddress | null }> {
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "a@b.c",
      fullName: "Ada Lovelace",
      cognitoSub: "sub-uuid",
      address,
    });
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);
    return new Promise((res, rej) =>
      client.GetUserById({ id: "usr_1" }, md, (err: unknown, reply: { address: WireAddress | null }) =>
        err ? rej(err) : res(reply),
      ),
    );
  }

  it("carries a camelCase-stored address, with postal_code populated", async () => {
    const res = await callWithStoredAddress({
      line1: "Avenida Winston Churchill",
      line2: null,
      city: "Santo Domingo",
      state: "Distrito Nacional",
      country: "DO",
      postalCode: "03201",
    });

    expect(res.address).toEqual({
      line1: "Avenida Winston Churchill",
      line2: "",
      city: "Santo Domingo",
      state: "Distrito Nacional",
      country: "DO",
      postal_code: "03201",
    });
  });

  it("carries a snake_case-stored address unchanged", async () => {
    const res = await callWithStoredAddress({ line1: "1 Ada Way", postal_code: "00901" });

    expect(res.address?.line1).toBe("1 Ada Way");
    expect(res.address?.postal_code).toBe("00901");
  });

  it("answers a user with no address without failing the lookup", async () => {
    const res = await callWithStoredAddress(null);

    expect(res.address).toBeNull();
  });

  it("answers with no address when the stored value is malformed", async () => {
    const res = await callWithStoredAddress("Avenida Winston Churchill 12");

    expect(res.address).toBeNull();
  });
});
