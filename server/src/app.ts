import Fastify, { type FastifyRequest, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomUUID, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z, ZodError } from "zod";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Pool, migrate, tx, type DB, type Client } from "./db.js";
import { type Config, aiConfigured } from "./config.js";
import {
  id,
  seq,
  iso,
  vehicle,
  ride,
  sample,
  assertStreamOrder,
  type StreamClock,
  APIError,
  fail,
} from "./validation.js";
import {
  hash,
  checkedBytes,
  atomicWrite,
  cleanup,
  CHUNK_SIZE,
  MAX_MANUAL,
} from "./storage.js";
import { processOneReport } from "./reports.js";
import { manualRoutes } from "./manuals.js";

declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
  }
  interface FastifyRequest {
    ownerId: string;
    deviceId: string;
  }
}
export interface Context {
  pool: DB;
  config: Config;
  ownTx: <T>(owner: string, fn: (c: Client) => Promise<T>) => Promise<T>;
}
export async function makeApp(
  config: Config,
  options: { jobs?: boolean } = {},
) {
  const pool = new Pool({ connectionString: config.databaseURL, max: 10 });
  await migrate(pool);
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const app = Fastify({
    logger: config.logging
      ? {
          level: process.env.LOG_LEVEL || "info",
          redact: [
            "req.headers.authorization",
            "req.body.code",
            "req.body.token",
          ],
          serializers: {
            req: (req) => ({
              method: req.method,
              url: req.url?.split("?")[0],
              remoteAddress: req.ip,
            }),
          },
        }
      : false,
    bodyLimit: CHUNK_SIZE,
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: CHUNK_SIZE },
    (_req, body, done) => done(null, body),
  );
  app.decorateRequest("ownerId", "");
  app.decorateRequest("deviceId", "");
  app.addHook("preHandler", async (req) => {
    if (req.routeOptions.config.public) return;
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 300)
      fail(401, "unauthorized", "Pair this device before continuing");
    const result = await pool.query(
      "SELECT id,owner_id FROM devices WHERE token_hash=$1",
      [hash(authorization!.slice(7))],
    );
    if (!result.rows[0]) fail(401, "unauthorized", "Device token is invalid");
    req.ownerId = result.rows[0].owner_id;
    req.deviceId = result.rows[0].id;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof APIError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_input",
            message: error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        });
    if ((error as { code?: string }).code === "23505")
      return reply
        .code(409)
        .send({
          error: { code: "conflict", message: "Resource already exists" },
        });
    if ((error as { code?: string }).code === "23503")
      return reply
        .code(409)
        .send({
          error: {
            code: "resource_in_use",
            message: "Resource is referenced by another record",
          },
        });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply
        .code(status)
        .send({
          error: {
            code: status === 429 ? "rate_limited" : "invalid_request",
            message: status === 429 ? "Too many requests" : "Invalid request",
          },
        });
    app.log.error(
      {
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
      },
      "Request failed",
    );
    return reply
      .code(500)
      .send({
        error: {
          code: "internal_error",
          message: "Request could not be completed",
        },
      });
  });
  const ownTx: Context["ownTx"] = (owner, fn) =>
    tx(pool, async (c) => {
      const r = await c.query(
        "SELECT id FROM owners WHERE id=$1 FOR KEY SHARE",
        [owner],
      );
      if (!r.rows[0]) fail(401, "unauthorized", "Account no longer exists");
      return fn(c);
    });
  const ctx: Context = { pool, config, ownTx };
  app.get("/healthz", { config: { public: true } }, async () => {
    await pool.query("SELECT 1");
    return { status: "ok", service: "motuo-api", version: "0.1.0" };
  });
  app.post(
    "/v1/pair",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const body = z
        .object({
          code: z.string().min(8).max(120),
          deviceName: z.string().min(1).max(120),
        })
        .parse(req.body);
      return tx(pool, async (c) => {
        const result = await c.query(
          "SELECT owner_id FROM pairing_codes WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",
          [hash(body.code)],
        );
        if (!result.rows[0])
          fail(
            401,
            "invalid_pairing_code",
            "Pairing code is invalid, expired or already used",
          );
        const ownerId = result.rows[0].owner_id,
          deviceId = randomUUID(),
          token = randomBytes(32).toString("base64url");
        await c.query(
          "INSERT INTO devices(id,owner_id,name,token_hash) VALUES($1,$2,$3,$4)",
          [deviceId, ownerId, body.deviceName, hash(token)],
        );
        await c.query(
          "UPDATE pairing_codes SET consumed_at=now() WHERE code_hash=$1",
          [hash(body.code)],
        );
        return { token, deviceId, ownerId };
      });
    },
  );
  app.get("/v1/capabilities", async () => ({
    ai: { configured: aiConfigured(config) },
    navigation: { provider: "amap", embeddedEnabled: false },
    version: "0.1.0",
  }));
  app.get("/v1/vehicles", async (req) => ({
    items: (
      await pool.query(
        "SELECT data FROM vehicles WHERE owner_id=$1 ORDER BY created_at",
        [req.ownerId],
      )
    ).rows.map((r) => r.data),
  }));
  app.put("/v1/vehicles/:id", async (req) => {
    const key = id((req.params as any).id),
      body = vehicle.parse(req.body);
    if (key !== body.id) fail(400, "id_mismatch", "Body id must match URL");
    return ownTx(req.ownerId, async (c) => {
      const existing = await c.query(
        "SELECT owner_id FROM vehicles WHERE id=$1 FOR UPDATE",
        [key],
      );
      if (existing.rows[0] && existing.rows[0].owner_id !== req.ownerId)
        fail(404, "not_found", "Vehicle not found");
      const saved = await c.query(
        "INSERT INTO vehicles(id,owner_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=now() WHERE vehicles.owner_id=excluded.owner_id RETURNING id",
        [key, req.ownerId, body],
      );
      if (!saved.rowCount) fail(404, "not_found", "Vehicle not found");
      return body;
    });
  });
  app.delete("/v1/vehicles/:id", async (req) =>
    ownTx(req.ownerId, async (c) => {
      const r = await c.query(
        "DELETE FROM vehicles WHERE id=$1 AND owner_id=$2 RETURNING id",
        [id((req.params as any).id), req.ownerId],
      );
      if (!r.rowCount) fail(404, "not_found", "Vehicle not found");
      return { deleted: true };
    }),
  );
  app.get("/v1/rides", async (req) => ({
    items: (
      await pool.query(
        "SELECT data FROM rides WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 500",
        [req.ownerId],
      )
    ).rows.map((r) => r.data),
  }));
  app.get("/v1/rides/:id", async (req) => (await getRide(pool, req)).data);
  app.put("/v1/rides/:id", async (req) => {
    const key = id((req.params as any).id),
      body = ride.parse(req.body);
    if (body.id !== key) fail(400, "id_mismatch", "Body id must match URL");
    if (body.endedAt && Date.parse(body.endedAt) < Date.parse(body.startedAt))
      fail(400, "invalid_time", "End precedes start");
    return ownTx(req.ownerId, async (c) => {
      await requireVehicle(c, body.vehicleId, req.ownerId);
      const existing = (
        await c.query("SELECT * FROM rides WHERE id=$1 FOR UPDATE", [key])
      ).rows[0];
      if (existing && existing.owner_id !== req.ownerId)
        fail(404, "not_found", "Ride not found");
      if (
        existing?.finalized_version !== null &&
        existing?.finalized_version !== undefined
      ) {
        if (!isDeepStrictEqual(existing.data, body))
          fail(409, "ride_finalized", "Finalized ride data is immutable");
        return existing.data;
      }
      if (
        existing &&
        (body.dataVersion < existing.data.dataVersion ||
          body.source !== existing.data.source ||
          body.vehicleId !== existing.vehicle_id ||
          body.startedAt !== existing.data.startedAt)
      )
        fail(
          409,
          "version_conflict",
          "Ride identity, source and version conflict",
        );
      const saved = await c.query(
        "INSERT INTO rides(id,owner_id,vehicle_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=now() WHERE rides.owner_id=excluded.owner_id RETURNING id",
        [key, req.ownerId, body.vehicleId, body],
      );
      if (!saved.rowCount) fail(404, "not_found", "Ride not found");
      return body;
    });
  });
  app.put("/v1/rides/:id/chunks/:sequence", async (req) => {
    const key = id((req.params as any).id),
      sequence = seq((req.params as any).sequence),
      chunk = checkedBytes(req.body, req.headers["x-content-sha256"]);
    return ownTx(req.ownerId, async (c) => {
      const row = await getRide(c, req, true),
        existing = (
          await c.query(
            "SELECT sha256 FROM ride_chunks WHERE ride_id=$1 AND sequence=$2",
            [key, sequence],
          )
        ).rows[0];
      if (existing) {
        if (existing.sha256 !== chunk.digest)
          fail(
            409,
            "chunk_conflict",
            "This sequence already has different content",
          );
        return { stored: true, duplicate: true, sequence };
      }
      if (row.finalized_version !== null)
        fail(409, "ride_finalized", "Finalized ride cannot accept new data");
      let samples: z.infer<typeof sample>[];
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          chunk.bytes,
        );
        const lines = content.trim().split("\n");
        if (lines.length > 60000)
          fail(400, "too_many_samples", "Chunk contains too many samples");
        samples = lines.map((line) => sample.parse(JSON.parse(line)));
      } catch (e) {
        if (e instanceof APIError) throw e;
        fail(
          422,
          "invalid_telemetry",
          "Chunk must contain valid UTF-8 TelemetrySample JSONL",
        );
      }
      if (samples!.some((s) => s.source !== row.data.source))
        fail(422, "source_mismatch", "Telemetry source must match ride source");
      assertStreamOrder(samples!);
      await atomicWrite(
        path.join(config.dataDir, "rides", key, "chunks", `${sequence}.jsonl`),
        chunk.bytes,
      );
      await c.query(
        "INSERT INTO ride_chunks(ride_id,sequence,sha256,bytes,sample_count) VALUES($1,$2,$3,$4,$5)",
        [key, sequence, chunk.digest, chunk.bytes.length, samples!.length],
      );
      return { stored: true, duplicate: false, sequence };
    });
  });
  app.post("/v1/rides/:id/finish", async (req) => {
    const key = id((req.params as any).id),
      body = z
        .object({
          dataVersion: z.number().int().min(1),
          expectedChunks: z.number().int().min(0).max(100000),
          summary: z.record(z.unknown()),
          endedAt: iso,
        })
        .parse(req.body);
    return ownTx(req.ownerId, async (c) => {
      const row = await getRide(c, req, true);
      if (row.finalized_version !== null) {
        if (row.finalized_version !== body.dataVersion)
          fail(
            409,
            "version_conflict",
            "Report belongs to another finalized version",
          );
        const storedCount = Number(
          (
            await c.query("SELECT count(*) FROM ride_chunks WHERE ride_id=$1", [
              key,
            ])
          ).rows[0].count,
        );
        if (
          storedCount !== body.expectedChunks ||
          row.data.endedAt !== body.endedAt ||
          !isDeepStrictEqual(row.data.summary, body.summary)
        )
          fail(
            409,
            "finish_conflict",
            "Finalized ride receipt differs from this request",
          );
        return {
          status: "finished",
          reportStatus:
            (
              await c.query("SELECT status FROM reports WHERE ride_id=$1", [
                key,
              ])
            ).rows[0]?.status || "pending",
        };
      }
      if (row.data.dataVersion !== body.dataVersion)
        fail(
          409,
          "version_conflict",
          "Finish dataVersion must match latest ride",
        );
      if (Date.parse(body.endedAt) < Date.parse(row.data.startedAt))
        fail(400, "invalid_time", "End precedes start");
      const chunks = (
        await c.query(
          "SELECT sequence,sha256 FROM ride_chunks WHERE ride_id=$1 ORDER BY sequence",
          [key],
        )
      ).rows;
      if (
        chunks.length !== body.expectedChunks ||
        chunks.some((r, i) => r.sequence !== i)
      )
        fail(
          409,
          "missing_chunks",
          "Upload all expected consecutive chunks before finishing",
        );
      const streamClocks:StreamClock = new Map();
      for (const chunk of chunks) {
        const bytes = await fs.readFile(
          path.join(
            config.dataDir,
            "rides",
            key,
            "chunks",
            `${chunk.sequence}.jsonl`,
          ),
        );
        if (hash(bytes) !== chunk.sha256)
          fail(
            422,
            "stored_data_corrupt",
            "Stored telemetry failed checksum verification",
          );
        const lines = bytes.toString("utf8").trim().split("\n");
        assertStreamOrder(lines.map(line=>sample.parse(JSON.parse(line))),streamClocks);
      }
      const data = {
        ...row.data,
        status: "finished",
        endedAt: body.endedAt,
        summary: body.summary,
      };
      await c.query(
        "UPDATE rides SET data=$2,finalized_version=$3,updated_at=now() WHERE id=$1",
        [key, data, body.dataVersion],
      );
      await c.query(
        "INSERT INTO reports(ride_id,data_version,status) VALUES($1,$2,'pending')",
        [key, body.dataVersion],
      );
      return { status: "finished", reportStatus: "pending" };
    });
  });
  app.get("/v1/rides/:id/report", async (req) => {
    const row = await getRide(pool, req);
    const r = (
      await pool.query("SELECT * FROM reports WHERE ride_id=$1", [row.id])
    ).rows[0];
    if (!r)
      return {
        status: "unavailable",
        dataVersion: row.data.dataVersion,
        source: "local",
        text: "",
      };
    return {
      status: r.status === "processing" ? "pending" : r.status,
      dataVersion: r.data_version,
      source: r.source,
      text: r.text,
      createdAt: r.created_at.toISOString(),
    };
  });
  app.post("/v1/rides/:id/events/:eventId/feedback", async (req) => {
    const eventId = id((req.params as any).eventId),
      body = z
        .object({
          label: z.enum(["confirmed", "rejected"]),
          note: z.string().max(2000).default(""),
        })
        .parse(req.body);
    return ownTx(req.ownerId, async (c) => {
      const row = await getRide(c, req, true),
        event = row.data.events.find((e: { id: string }) => e.id === eventId);
      if (!event) fail(404, "not_found", "Event not found");
      await c.query(
        "INSERT INTO event_feedback(ride_id,event_id,label,note,event_snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT(ride_id,event_id) DO UPDATE SET label=excluded.label,note=excluded.note,updated_at=now()",
        [row.id, eventId, body.label, body.note, event],
      );
      return { saved: true, eventId, ...body, event };
    });
  });
  app.delete("/v1/rides/:id", async (req) => {
    await ownTx(req.ownerId, async (c) => {
      const row = await getRide(c, req, true);
      await c.query(
        "INSERT INTO file_cleanup(id,kind) VALUES($1,'ride') ON CONFLICT DO NOTHING",
        [row.id],
      );
      await c.query("DELETE FROM rides WHERE id=$1", [row.id]);
    });
    await cleanup(pool, config.dataDir);
    return { deleted: true };
  });
  app.get("/v1/maintenance", async (req) => {
    const key = id((req.query as any).vehicleId);
    await requireVehicle(pool, key, req.ownerId);
    return {
      items: (
        await pool.query(
          "SELECT data FROM maintenance WHERE owner_id=$1 AND vehicle_id=$2 ORDER BY created_at DESC",
          [req.ownerId, key],
        )
      ).rows.map((r) => r.data),
    };
  });
  app.post("/v1/maintenance", async (req) => {
    const body = z
      .object({
        id: z.string().uuid(),
        vehicleId: z.string().uuid(),
        performedAt: iso,
        odometerKM: z.number().finite().nonnegative(),
        category: z.string().min(1).max(100),
        note: z.string().max(10000),
      })
      .parse(req.body);
    return ownTx(req.ownerId, async (c) => {
      await requireVehicle(c, body.vehicleId, req.ownerId);
      const row = (
        await c.query("SELECT * FROM maintenance WHERE id=$1 FOR UPDATE", [
          body.id,
        ])
      ).rows[0];
      if (row) {
        if (row.owner_id !== req.ownerId)
          fail(404, "not_found", "Record not found");
        if (!isDeepStrictEqual(row.data, body))
          fail(409, "record_conflict", "Maintenance record is immutable");
        return row.data;
      }
      await c.query(
        "INSERT INTO maintenance(id,owner_id,vehicle_id,data) VALUES($1,$2,$3,$4)",
        [body.id, req.ownerId, body.vehicleId, body],
      );
      return body;
    });
  });
  await manualRoutes(app, ctx);
  app.delete("/v1/account", async (req) => {
    await tx(pool, async (c) => {
      await c.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [
        req.ownerId,
      ]);
      await c.query(
        "INSERT INTO file_cleanup(id,kind) SELECT id,'manual' FROM manuals WHERE owner_id=$1 ON CONFLICT DO NOTHING",
        [req.ownerId],
      );
      await c.query(
        "INSERT INTO file_cleanup(id,kind) SELECT id,'ride' FROM rides WHERE owner_id=$1 ON CONFLICT DO NOTHING",
        [req.ownerId],
      );
      await c.query("DELETE FROM manuals WHERE owner_id=$1", [req.ownerId]);
      await c.query("DELETE FROM maintenance WHERE owner_id=$1", [req.ownerId]);
      await c.query("DELETE FROM rides WHERE owner_id=$1", [req.ownerId]);
      await c.query("DELETE FROM owners WHERE id=$1", [req.ownerId]);
    });
    await cleanup(pool, config.dataDir);
    return { deleted: true };
  });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processOneReport(pool, config);
      await cleanup(pool, config.dataDir);
    } catch {
      app.log.error("Background job failed; retry scheduled");
    } finally {
      running = false;
    }
  };
  const timer =
    options.jobs === false ? undefined : setInterval(() => void tick(), 1000);
  timer?.unref();
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    while (running) await new Promise((r) => setTimeout(r, 50));
    await pool.end();
  });
  return { app, pool, processReports: () => processOneReport(pool, config) };
}
export async function requireVehicle(
  db: DB | Client,
  key: string,
  owner: string,
) {
  const row = (
    await db.query("SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2", [
      key,
      owner,
    ])
  ).rows[0];
  if (!row) fail(404, "not_found", "Vehicle not found");
}
export async function getRide(
  db: DB | Client,
  req: FastifyRequest,
  lock = false,
) {
  const row = (
    await db.query(
      "SELECT * FROM rides WHERE id=$1 AND owner_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id((req.params as any).id), req.ownerId],
    )
  ).rows[0];
  if (!row) fail(404, "not_found", "Ride not found");
  return row;
}
