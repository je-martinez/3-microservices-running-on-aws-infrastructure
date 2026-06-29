import { request, type APIRequestContext } from "@playwright/test";

export async function apiClient(): Promise<APIRequestContext> {
  const baseURL = process.env.API_INVOKE_URL;
  if (!baseURL) throw new Error("API_INVOKE_URL is required for E2E (the API Gateway invoke URL)");
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
}
