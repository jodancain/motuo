import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const { Pool } = pg;
export type DB = pg.Pool;
export type Client = pg.PoolClient;
export async function migrate(pool: DB) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(8137101)");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = here.includes("/dist/")
      ? path.resolve(here, "../../schema.sql")
      : path.resolve(here, "../schema.sql");
    await client.query(await readFile(file, "utf8"));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function tx<T>(
  pool: DB,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
