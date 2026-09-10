import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { buildGrpcServer } from "#shared/grpc/server";

// Exercised over a REAL server, a REAL client and the REAL proto rather than by
// asserting on the callback's argument: the bug this covers was an omitted
// field, and a mocked callback happily accepts whatever object it is handed.
// Only serialization proves the address reaches the caller. See
// [[mocks-hide-schema-bugs]].
const PROTO_PATH = fileURLToPath(new URL("../../../../../proto/users.proto", import.meta.url));

const proto = grpc.loadPackageDefinition(
  protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    defaults: true,
    oneofs: true,
  }),
) as unknown as { users: { v1: { Users: grpc.ServiceClientConstructor } } };

const BASE_USER = {
  id: "usr_1",
  email: "a@b.c",
  fullName: "Ada Lovelace",
  cognitoSub: "sub-uuid",
};

interface WireAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
}

let running: { server: grpc.Server; client: grpc.Client } | null = null;

afterEach(() => {
  running?.client.close();
  running?.server.forceShutdown();
  running = null;
});

async function callWithStoredAddress(address: unknown) {
  const userQueryService = { getUserById: async () => ({ ...BASE_USER, address }) };
  const server = buildGrpcServer({ userQueryService } as never);
  const port = await new Promise<number>((resolvePort, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolvePort(bound),
    );
  });

  const client = new proto.users.v1.Users(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  running = { server, client };

  const metadata = new grpc.Metadata();
  metadata.set("x-api-key", "test-grpc-key");

  return new Promise<{ address: WireAddress | null }>((resolveCall, reject) => {
    (client as unknown as Record<string, CallableFunction>).GetUserById(
      { id: "usr_1" },
      metadata,
      (err: grpc.ServiceError | null, res: { address: WireAddress | null }) =>
        err ? reject(err) : resolveCall(res),
    );
  });
}

describe("GetUserById address on the wire", () => {
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
