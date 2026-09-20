import { makeApp } from "./app.js";
import { configFromEnv } from "./config.js";
const { app } = await makeApp(configFromEnv());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
await app.listen({
  port: Number(process.env.PORT || 3020),
  host: process.env.HOST || "0.0.0.0",
});
