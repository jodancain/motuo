import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type DB } from "./db.js";
import { fail } from "./validation.js";
export const CHUNK_SIZE = 4194304;
export const MAX_MANUAL = 256 * 1024 * 1024;
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function checkedBytes(raw: unknown, digest: unknown) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > CHUNK_SIZE)
    fail(400, "invalid_chunk", "A non-empty raw chunk up to 4 MiB is required");
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest))
    fail(400, "invalid_checksum", "X-Content-SHA256 is required");
  const bytes = raw as Buffer,
    actual = hash(bytes);
  if (actual !== String(digest).toLowerCase())
    fail(422, "checksum_mismatch", "Chunk checksum does not match");
  return { bytes, digest: actual };
}
export async function atomicWrite(target: string, bytes: Buffer) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + ".tmp-" + randomUUID();
  try {
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
export async function cleanup(pool: DB, root: string) {
  const jobs = await pool.query("SELECT id,kind FROM file_cleanup LIMIT 100");
  for (const row of jobs.rows) {
    try {
      if (row.kind === "manual") {
        await fs.rm(path.join(root, "manuals", row.id), {
          recursive: true,
          force: true,
        });
        await fs.rm(path.join(root, "uploads", "manuals", row.id), {
          recursive: true,
          force: true,
        });
      } else if (row.kind === "ride")
        await fs.rm(path.join(root, "rides", row.id), {
          recursive: true,
          force: true,
        });
      else continue;
      await pool.query("DELETE FROM file_cleanup WHERE id=$1 AND kind=$2", [
        row.id,
        row.kind,
      ]);
    } catch {
      /* Durable job remains for next sweep. */
    }
  }
}
