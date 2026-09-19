// CONTRACT: A token per dependency whose type is an interface or a type alias.
// Those have no runtime class for Nest to inject by, so each needs an explicit
// @Inject(TOKEN) at its call site. A class-typed dependency is injected by type
// and must NOT be listed here. See [[dependency-injection]]
export const DB = Symbol.for("users:db");
export const AUTH_PROVIDER = Symbol.for("users:authProvider");
export const EVENT_PUBLISHER = Symbol.for("users:eventPublisher");
export const REDIS = Symbol.for("users:redis");
