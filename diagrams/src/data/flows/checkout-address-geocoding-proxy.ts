import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: drawn as it runs in local dev: the web nginx, OpenObserve and Users in Docker Compose,
// API Gateway on Floci, Geoapify on the internet. Replies reuse the request edges. Sources:
// apps/web/nginx.conf, docker-compose.yml (web logging driver), apps/web/src/app/core/api/geocode-api.ts.
export const checkoutAddressGeocodingProxy: z.input<typeof AwsDiagramData> = {
  title: "Street autocomplete through a same-origin proxy",
  subtitle: "Local dev. The Geoapify key lives in nginx; the browser never sees it or sends a token there",
  direction: "RIGHT",
  groups: [
    { id: "compose-web", kind: "generic", label: "Docker Compose: web" },
    { id: "compose-o2", kind: "generic", label: "Docker Compose: observability" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "compose", kind: "generic", label: "Docker Compose: services" },
  ],
  nodes: [
    { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
    { id: "nginx", label: "Web nginx", icon: "server", group: "compose-web" },
    { id: "geoapify", label: "Geoapify", icon: "internet" },
    { id: "o2", label: "OpenObserve", icon: "server", group: "compose-o2" },
    { id: "gateway", label: "API Gateway", sublabel: "JWT authorizer", icon: "api-gateway", group: "floci" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
  ],
  edges: [
    { id: "web-nginx", from: "web", to: "nginx", label: "same-origin" },
    { id: "nginx-geoapify", from: "nginx", to: "geoapify", label: "+ API key" },
    { id: "nginx-o2", from: "nginx", to: "o2", label: "access log via fluentd", async: true },
    { id: "nginx-gateway", from: "nginx", to: "gateway", label: "API path" },
    { id: "gateway-users", from: "gateway", to: "users" },
  ],
  steps: [
    { edges: ["web-nginx"], caption: "After a 300 ms debounce and 3+ characters, a same-origin call with no bearer token" },
    { edges: ["web-nginx"], caption: "If the key is unset, nginx answers 503 itself rather than burn free-tier quota" },
    { edges: ["nginx-geoapify"], caption: "nginx appends the key and strips Authorization and Cookie before leaving the host" },
    { edges: ["nginx-geoapify"], caption: "OpenStreetMap streets; Santo Domingo results carry no house numbers" },
    { edges: ["nginx-o2"], caption: "The only logged location, so the free-tier call count is a web-geocode query" },
    { edges: ["web-nginx"], caption: "Entries without a street are dropped; any failure degrades to an empty list" },
    { edges: ["web-nginx"], caption: "The buyer picks a street, types the house number and saves" },
    { edges: ["nginx-gateway"], caption: "The same nginx proxies the API path to the gateway, where the JWT authorizer runs" },
    { edges: ["gateway-users"], caption: "Users stores the address on the buyer's profile" },
    { edges: ["gateway-users", "nginx-gateway", "web-nginx"], caption: "The returned profile replaces the session user and re-renders the address card" },
  ],
};
