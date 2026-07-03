import { env } from "#shared/config/env";
import { buildApp } from "#features/users/http/routes";

const app = buildApp();
app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
