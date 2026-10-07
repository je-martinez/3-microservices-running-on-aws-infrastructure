import type { FlowData } from "../../schema";

export const checkoutAddressGeocodingProxy: FlowData = {
  title: "Street autocomplete through a same-origin proxy",
  subtitle: "The Geoapify key lives in nginx; the browser never sees it or sends a token there",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "nginx", label: "Web nginx", kind: "edge" },
    { id: "geoapify", label: "Geoapify", kind: "external" },
    { id: "o2", label: "OpenObserve", kind: "data" },
    { id: "gateway", label: "API Gateway", kind: "edge", aws: "api-gateway" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
  ],
  steps: [
    { from: "web", to: "nginx", label: "Street query", caption: "After a 300 ms debounce and 3+ characters, a same-origin call with no bearer token" },
    { from: "nginx", to: "web", label: "503 disabled", caption: "If the key is unset, nginx answers 503 itself rather than burn free-tier quota" },
    { from: "nginx", to: "geoapify", label: "Autocomplete", caption: "nginx appends the key and strips Authorization and Cookie before leaving the host" },
    { from: "geoapify", to: "nginx", label: "Suggestions", caption: "OpenStreetMap streets; Santo Domingo results carry no house numbers" },
    { from: "nginx", to: "o2", label: "Access log", caption: "The only logged location, so the free-tier call count is a web-geocode query", async: true },
    { from: "nginx", to: "web", label: "Suggestions", caption: "Entries without a street are dropped; any failure degrades to an empty list" },
    { from: "web", to: "nginx", label: "Save address", caption: "The buyer picks a street, types the house number and saves" },
    { from: "nginx", to: "gateway", label: "Profile update", caption: "The same nginx proxies the API path to the gateway, where the JWT authorizer runs" },
    { from: "gateway", to: "users", label: "Update profile", caption: "Users stores the address on the buyer's profile" },
    { from: "users", to: "web", label: "Profile", caption: "The returned profile replaces the session user and re-renders the address card" },
  ],
};
