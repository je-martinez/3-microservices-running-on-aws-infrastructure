import { execSync } from "node:child_process";

export default async function globalSetup() {
  execSync("docker compose up -d", { stdio: "inherit" });
  const base = process.env.API_INVOKE_URL;
  if (!base) throw new Error("API_INVOKE_URL is required");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Stack did not become healthy within 120s");
}
