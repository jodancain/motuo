import { Pool, migrate } from "./db.js";
import { configFromEnv } from "./config.js";
const pool = new Pool({ connectionString: configFromEnv().databaseURL });
try {
  await migrate(pool);
  console.log("Schema ready");
} finally {
  await pool.end();
}
