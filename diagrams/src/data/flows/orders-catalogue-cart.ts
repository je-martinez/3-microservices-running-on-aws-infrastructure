import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as it runs in local dev: Orders and Users in Docker Compose, ElastiCache on Floci
// outside the VPC (no subnet group), the Orders DB (RDS MySQL) in module.networking's subnets.
// Sources: services/orders/src/Orders.Api/Endpoints/{Cart,Product}Endpoints.cs,
// services/orders/src/Orders.Infrastructure/{Carts,Caching}, infra/modules/{networking,redis}.
export const ordersCatalogueCart: z.input<typeof AwsDiagramData> = {
  title: "Browse the catalogue and edit the cart",
  subtitle: "Local dev. Orders owns the cart and every figure; the web app renders what it is sent",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "orders", label: "Orders service", icon: "server", group: "compose" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "cache", label: "Response cache", sublabel: "ElastiCache", icon: "elasticache", group: "floci" },
    { id: "db", label: "Orders DB", sublabel: "RDS MySQL", icon: "rds", group: "subnets" },
  ],
  edges: [
    { id: "web-orders", from: "web", to: "orders", label: "via API Gateway" },
    { id: "orders-users", from: "orders", to: "users", label: "gRPC" },
    { id: "orders-cache", from: "orders", to: "cache" },
    { id: "orders-db", from: "orders", to: "db" },
  ],
  steps: [
    { edges: ["web-orders"], caption: "The home page loads the catalogue once; category chips and search filter in the browser" },
    { edges: ["orders-cache"], caption: "One key shared by every buyer, 10-minute TTL; a miss goes on to the DB" },
    { edges: ["web-orders"], caption: "The drawer reads the cart on open; a buyer with no cart gets an empty one, never a 404" },
    { edges: ["orders-users"], caption: "Per-user keys need the user id: the identity cache first, else Users over gRPC" },
    { edges: ["orders-cache"], caption: "A per-user key with a 60-second TTL; a hit returns the stored body without the handler" },
    { edges: ["orders-db"], caption: "On a miss one catalogue query prices every line and flags unavailable ones" },
    { edges: ["web-orders"], caption: "Stepper clicks debounce per product and queue, so a burst becomes one full replacement" },
    { edges: ["orders-db"], caption: "One transaction; no live lines deletes the cart; a lost create race retries once" },
    { edges: ["orders-cache"], caption: "After the commit, the caller's whole per-user key index is swept" },
    { edges: ["web-orders"], caption: "Totals count available lines only; canCheckout gates the drawer's Continue button" },
  ],
};
