// The six strings of `users.v1.Address`, in the proto's own spelling. The proto
// is loaded with `keepCase: true`, so the wire field really is `postal_code`.
export interface GrpcAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Maps the stored address onto the wire message. `undefined` means "no address":
// an absent field and an explicit null are indistinguishable to the client, and
// Orders' `ToAddress` maps both to a null shipping address.
export function toGrpcAddress(stored: unknown): GrpcAddress | undefined {
  // CONTRACT: `address` is schema-free JSON (`address Json?`), so the stored
  // value may be a string, an array, or a partial object. Never throw here — a
  // malformed address degrades to "no address", it does not fail the lookup.
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;

  const source = stored as Record<string, unknown>;
  const address: GrpcAddress = {
    line1: stringOrEmpty(source.line1),
    line2: stringOrEmpty(source.line2),
    city: stringOrEmpty(source.city),
    state: stringOrEmpty(source.state),
    country: stringOrEmpty(source.country),
    // CONTRACT: accept BOTH spellings, emit `postal_code`. The web app persists
    // camelCase, so reading only the proto spelling drops the postal code
    // silently. The other five names coincide in both spellings.
    postal_code: stringOrEmpty(source.postal_code ?? source.postalCode),
  };

  // An address blank in every field means the user has none on file — the same
  // collapse Orders applies on receipt, done one hop earlier.
  const hasValue = Object.values(address).some((field) => field.trim() !== "");
  return hasValue ? address : undefined;
}
