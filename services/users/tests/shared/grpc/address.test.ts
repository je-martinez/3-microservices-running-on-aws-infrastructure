import { describe, it, expect } from "vitest";
import { toGrpcAddress } from "#shared/grpc/address";

const FULL = {
  line1: "Avenida Winston Churchill",
  line2: "",
  city: "Santo Domingo",
  state: "Distrito Nacional",
  country: "DO",
  postal_code: "03201",
};

describe("toGrpcAddress", () => {
  it("maps a camelCase stored address, emitting postal_code on the wire", () => {
    // The shape the web app actually persists.
    expect(
      toGrpcAddress({
        line1: "Avenida Winston Churchill",
        line2: null,
        city: "Santo Domingo",
        state: "Distrito Nacional",
        country: "DO",
        postalCode: "03201",
      }),
    ).toEqual(FULL);
  });

  it("maps a snake_case stored address", () => {
    expect(toGrpcAddress({ ...FULL })).toEqual(FULL);
  });

  it("prefers postal_code when a row carries both spellings", () => {
    const mixed = toGrpcAddress({ ...FULL, postalCode: "99999" });
    expect(mixed?.postal_code).toBe("03201");
  });

  it("fills the fields a partial address omits with empty strings", () => {
    expect(toGrpcAddress({ line1: "1 Ada Way", country: "PR" })).toEqual({
      line1: "1 Ada Way",
      line2: "",
      city: "",
      state: "",
      country: "PR",
      postal_code: "",
    });
  });

  it("ignores keys the proto does not declare", () => {
    const mapped = toGrpcAddress({ line1: "1 Ada Way", latitude: 18.4, notes: { a: 1 } });
    expect(Object.keys(mapped!).sort()).toEqual([
      "city",
      "country",
      "line1",
      "line2",
      "postal_code",
      "state",
    ]);
  });

  it("coerces a non-string field to an empty string rather than putting it on the wire", () => {
    expect(toGrpcAddress({ line1: "1 Ada Way", postalCode: 3201 })?.postal_code).toBe("");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "Avenida Winston Churchill 12"],
    ["a number", 42],
    ["an array", [{ line1: "1 Ada Way" }]],
    ["an empty object", {}],
    ["an all-blank object", { line1: "", city: "   ", postalCode: "" }],
  ])("returns undefined for %s", (_label, stored) => {
    expect(toGrpcAddress(stored)).toBeUndefined();
  });
});
