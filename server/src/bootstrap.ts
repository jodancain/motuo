import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Pool, migrate, tx } from "./db.js";
import { configFromEnv } from "./config.js";
const pool = new Pool({ connectionString: configFromEnv().databaseURL });
try {
  await migrate(pool);
  const ownerId = process.env.OWNER_ID || randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(ownerId)) throw new Error("Invalid OWNER_ID");
  const code = randomBytes(9).toString("base64url");
  await tx(pool, async (c) => {
    await c.query("INSERT INTO owners(id) VALUES($1) ON CONFLICT DO NOTHING", [
      ownerId,
    ]);
    await c.query(
      "INSERT INTO pairing_codes(code_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",
      [createHash("sha256").update(code).digest("hex"), ownerId],
    );
  });
  console.log(JSON.stringify({ ownerId, code, expiresInSeconds: 900 }));
} finally {
  await pool.end();
}
