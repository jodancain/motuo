import { test } from "node:test";
import { isolatedTestDatabase } from "./database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { type Config } from "../src/config.js";
import { makeApp } from "../src/app.js";
import { hash, CHUNK_SIZE, MAX_MANUAL } from "../src/storage.js";
import { numberSupported,localReport } from "../src/ai.js";

test("real PostgreSQL API integration", async (t) => {
  assert.ok(
    process.env.DATABASE_URL,
    "Use npm run test:integration (private disposable PostgreSQL)",
  );
  const database = await isolatedTestDatabase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motuo-api-test-"));
  const apiConfig: Config = {
    databaseURL: database.url,
    dataDir: root,
    aiBaseURL: "",
    aiModel: "",
    aiKey: "",
    aiTimeoutMS: 500,
    logging: false,
  };
  const { app, pool, processReports } = await makeApp(apiConfig, {
    jobs: false,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
    await database.close();
  });
  const owner = randomUUID(),
    otherOwner = randomUUID(),
    code = "pair-" + randomUUID(),
    otherCode = "pair-" + randomUUID();
  await pool.query("INSERT INTO owners(id) VALUES($1),($2)", [
    owner,
    otherOwner,
  ]);
  await pool.query(
    "INSERT INTO pairing_codes(code_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '1 minute'),($3,$4,now()+interval '1 minute')",
    [hash(code), owner, hash(otherCode), otherOwner],
  );
  const pair = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code, deviceName: "test iPhone" },
  });
  assert.equal(pair.statusCode, 200, pair.body);
  const token = pair.json().token,
    headers = { authorization: `Bearer ${token}` };
  const second = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code: otherCode, deviceName: "other iPhone" },
  });
  const foreign = { authorization: `Bearer ${second.json().token}` };
  const vehicleId = randomUUID(),
    rideId = randomUUID(),
    eventId = randomUUID();
  const vehicle = {
    id: vehicleId,
    name: "GSX250R",
    make: "Suzuki",
    model: "GSX250R",
    year: null,
    abs: null,
    displacementCC: 248,
    plate: "",
    tyres: "",
    modifications: "",
    odometerKM: 1200,
  };
  const ride = {
    id: rideId,
    vehicleId,
    startedAt: "2026-09-14T02:00:00Z",
    endedAt: null,
    status: "recording",
    source: "measured",
    distanceM: 12500,
    durationS: 1200,
    maxSpeedMPS: 12,
    meanSpeedMPS: 10,
    dataVersion: 1,
    events: [
      {
        id: eventId,
        type: "possible_shift",
        window: { start: "2026-09-14T02:00:01Z", end: "2026-09-14T02:00:02Z" },
        confidence: 0.4,
      },
    ],
    summary: {},
  };
  const sample = {
    stream:"location",segmentId:randomUUID(),
    timestamp: "2026-09-14T02:00:01Z",
    monotonicS: 1,
    source: "measured",
    speedMPS: 5,
    latitude:31.2,longitude:121.4,horizontalAccuracyM:5,
    quality: "valid",
  };
  const bytes = Buffer.from(JSON.stringify(sample) + "\n");
  const upload = (url: string, body: Buffer, auth = headers) =>
    app.inject({
      method: "PUT",
      url,
      headers: {
        ...auth,
        "content-type": "application/octet-stream",
        "x-content-sha256": hash(body),
      },
      payload: body,
    });
  await t.test("device pairing stores hashes and is one-use", async () => {
    const stored = (
      await pool.query("SELECT token_hash FROM devices WHERE id=$1", [
        pair.json().deviceId,
      ])
    ).rows[0];
    assert.equal(stored.token_hash, hash(token));
    assert.notEqual(stored.token_hash, token);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/pair",
          payload: { code, deviceName: "repeat" },
        })
      ).statusCode,
      401,
    );
    assert.equal((await app.inject({ url: "/v1/vehicles" })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: "/v1/capabilities", headers })).json().ai
        .configured,
      false,
    );
  });
  await t.test(
    "real HTTP health and authenticated request use TCP and database",
    async () => {
      assert.equal((await fetch(address + "/healthz")).status, 200);
      assert.equal((await fetch(address + "/v1/vehicles")).status, 401);
      assert.equal(
        (await fetch(address + "/v1/vehicles", { headers })).status,
        200,
      );
    },
  );
  await t.test("vehicle CRUD scopes all writes and listing", async () => {
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/vehicles/${vehicleId}`,
          headers,
          payload: vehicle,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/v1/vehicles", headers })).json().items.length,
      1,
    );
    assert.equal(
      (await app.inject({ url: "/v1/vehicles", headers: foreign })).json().items
        .length,
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/vehicles/${vehicleId}`,
          headers: foreign,
          payload: { ...vehicle, name: "attacker" },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/vehicles/${vehicleId}`,
          headers: foreign,
        })
      ).statusCode,
      404,
    );
  });
  await t.test("ride upsert isolates ownership and version", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/v1/rides/${rideId}`,
      headers,
      payload: ride,
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await app.inject({ url: `/v1/rides/${rideId}`, headers: foreign }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/rides/${rideId}`,
          headers,
          payload: { ...ride, source: "simulated" },
        })
      ).statusCode,
      409,
    );
  });
  await t.test(
    "raw chunk checksum, schema and source are validated",
    async () => {
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: `/v1/rides/${rideId}/chunks/0`,
            headers: {
              ...headers,
              "content-type": "application/octet-stream",
              "x-content-sha256": "0".repeat(64),
            },
            payload: bytes,
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await upload(
            `/v1/rides/${rideId}/chunks/0`,
            Buffer.from('{"not":"sample"}\n'),
          )
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await upload(
            `/v1/rides/${rideId}/chunks/0`,
            Buffer.from(
              JSON.stringify({ ...sample, source: "simulated" }) + "\n",
            ),
          )
        ).statusCode,
        422,
      );
      assert.equal(
        (await upload(`/v1/rides/${rideId}/chunks/0`, bytes, foreign))
          .statusCode,
        404,
      );
    },
  );
  await t.test(
    "concurrent identical chunk upload is idempotent; conflict retains original",
    async () => {
      const r = await Promise.all([
        upload(`/v1/rides/${rideId}/chunks/0`, bytes),
        upload(`/v1/rides/${rideId}/chunks/0`, bytes),
      ]);
      assert.deepEqual(
        r.map((x) => x.statusCode),
        [200, 200],
      );
      assert.equal(r.filter((x) => x.json().duplicate).length, 1);
      assert.equal(
        (
          await upload(
            `/v1/rides/${rideId}/chunks/0`,
            Buffer.from(JSON.stringify({ ...sample, speedMPS: 6 })),
          )
        ).statusCode,
        409,
      );
      assert.deepEqual(
        await fs.readFile(path.join(root, "rides", rideId, "chunks/0.jsonl")),
        bytes,
      );
    },
  );
  await t.test("finish rejects missing chunks and wrong version", async () => {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/rides/${rideId}/finish`,
          headers,
          payload: {
            dataVersion: 1,
            expectedChunks: 2,
            summary: {},
            endedAt: "2026-09-14T02:20:00Z",
          },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/rides/${rideId}/finish`,
          headers,
          payload: {
            dataVersion: 2,
            expectedChunks: 1,
            summary: {},
            endedAt: "2026-09-14T02:20:00Z",
          },
        })
      ).statusCode,
      409,
    );
  });
  await t.test(
    "finish binds immutable report to dataVersion with truthful local fallback",
    async () => {
      const result = await app.inject({
        method: "POST",
        url: `/v1/rides/${rideId}/finish`,
        headers,
        payload: {
          dataVersion: 1,
          expectedChunks: 1,
          summary: { quality: "degraded" },
          endedAt: "2026-09-14T02:20:00Z",
        },
      });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(
        (
          await app.inject({ url: `/v1/rides/${rideId}/report`, headers })
        ).json().status,
        "pending",
      );
      assert.equal(await processReports(), true);
      const report = (
        await app.inject({ url: `/v1/rides/${rideId}/report`, headers })
      ).json();
      assert.equal(report.status, "ready");
      assert.equal(report.source, "local");
      assert.equal(report.dataVersion, 1);
      assert.match(report.text, /12.5/);
      assert.equal(
        (await upload(`/v1/rides/${rideId}/chunks/1`, bytes)).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: `/v1/rides/${rideId}`,
            headers,
            payload: { ...ride, dataVersion: 2 },
          })
        ).statusCode,
        409,
      );
    },
  );
  await t.test("event feedback preserves original event window", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/rides/${rideId}/events/${eventId}/feedback`,
      headers,
      payload: { label: "rejected", note: "停车操作" },
    });
    assert.equal(r.statusCode, 200, r.body);
    const snapshot = (
      await pool.query(
        "SELECT event_snapshot FROM event_feedback WHERE ride_id=$1",
        [rideId],
      )
    ).rows[0].event_snapshot;
    assert.deepEqual(snapshot, ride.events[0]);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/rides/${rideId}/events/${eventId}/feedback`,
          headers: foreign,
          payload: { label: "confirmed" },
        })
      ).statusCode,
      404,
    );
  });
  let manualId = "";
  const pdf = Buffer.from(
    "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF",
  );
  await t.test("manual declaration rejects oversized files", async () => {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/manuals",
          headers,
          payload: {
            vehicleId,
            fileName: "big.pdf",
            totalBytes: MAX_MANUAL + 1,
            sha256: hash(pdf),
          },
        })
      ).statusCode,
      400,
    );
    const r = await app.inject({
      method: "POST",
      url: "/v1/manuals",
      headers,
      payload: {
        vehicleId,
        fileName: "Suzuki.pdf",
        totalBytes: pdf.length,
        sha256: hash(pdf),
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    manualId = r.json().id;
    assert.equal(r.json().chunkSize, CHUNK_SIZE);
  });
  await t.test(
    "manual chunk and complete enforce size, order and ownership",
    async () => {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/v1/manuals/${manualId}/complete`,
            headers,
            payload: { expectedChunks: 1 },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await upload(`/v1/manuals/${manualId}/chunks/0`, pdf.subarray(1)))
          .statusCode,
        422,
      );
      assert.equal(
        (await upload(`/v1/manuals/${manualId}/chunks/0`, pdf)).statusCode,
        200,
      );
      assert.equal(
        (await upload(`/v1/manuals/${manualId}/chunks/0`, pdf)).json()
          .duplicate,
        true,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/v1/manuals/${manualId}/complete`,
            headers: foreign,
            payload: { expectedChunks: 1 },
          })
        ).statusCode,
        404,
      );
      const r = await app.inject({
        method: "POST",
        url: `/v1/manuals/${manualId}/complete`,
        headers,
        payload: { expectedChunks: 1 },
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().status, "queued");
      assert.deepEqual(
        await fs.readFile(path.join(root, "manuals", manualId, "original.pdf")),
        pdf,
      );
    },
  );
  await t.test(
    "authenticated PDF supports full, bounded and suffix ranges",
    async () => {
      assert.equal(
        (await app.inject({ url: `/v1/manuals/${manualId}/file` })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: `/v1/manuals/${manualId}/file`,
            headers: foreign,
          })
        ).statusCode,
        404,
      );
      assert.deepEqual(
        (await app.inject({ url: `/v1/manuals/${manualId}/file`, headers }))
          .rawPayload,
        pdf,
      );
      const range = await app.inject({
        url: `/v1/manuals/${manualId}/file`,
        headers: { ...headers, range: "bytes=0-7" },
      });
      assert.equal(range.statusCode, 206);
      assert.equal(range.body, "%PDF-1.7");
      assert.equal(
        (
          await app.inject({
            url: `/v1/manuals/${manualId}/file`,
            headers: { ...headers, range: "bytes=-5" },
          })
        ).body,
        "%%EOF",
      );
      assert.equal(
        (
          await app.inject({
            url: `/v1/manuals/${manualId}/file`,
            headers: { ...headers, range: "bytes=90000-" },
          })
        ).statusCode,
        416,
      );
      assert.equal(
        (
          await app.inject({
            url: `/v1/manuals/${manualId}/file`,
            headers: { ...headers, range: "bytes=1-2,4-5" },
          })
        ).statusCode,
        416,
      );
    },
  );
  await t.test(
    "manual search only uses ready matching-owner evidence with physical page references",
    async () => {
      let answer = (
        await app.inject({
          method: "POST",
          url: "/v1/manuals/ask",
          headers,
          payload: { vehicleId, question: "制动螺栓扭矩" },
        })
      ).json();
      assert.equal(answer.source, "no_evidence");
      await pool.query(
        "INSERT INTO manual_pages(manual_id,page,printed_page,section,text,tokens,quality) VALUES($1,7,'2-3','制动器','制动钳安装螺栓的紧固扭矩为 25 N·m。','制动 螺栓 扭矩 紧固 25 N·m','native')",
        [manualId],
      );
      await pool.query(
        "UPDATE manuals SET status='ready',page_count=7,progress=100 WHERE id=$1",
        [manualId],
      );
      answer = (
        await app.inject({
          method: "POST",
          url: "/v1/manuals/ask",
          headers,
          payload: { vehicleId, question: "制动螺栓扭矩" },
        })
      ).json();
      assert.equal(answer.source, "extractive");
      assert.equal(answer.citations[0].page, 7);
      assert.equal(answer.citations[0].printedPage, "2-3");
      assert.match(answer.answer, /25 N·m/);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/manuals/ask",
            headers: foreign,
            payload: { vehicleId, question: "制动螺栓扭矩" },
          })
        ).statusCode,
        404,
      );
    },
  );
  await t.test(
    "parameter retrieval distinguishes nearby quantity units from sensor discussion without model-specific values",
    async () => {
      const values = [
        [31, "TEST 规格参数\n发动机冷却液 | | 1675 ml\n主保险 | 40 A\n普通保险 | 7.5 A"],
        [32, "发动机冷却液温度传感器的输入电压是 5 V。手册标注发动机冷却液的检查方法。"],
        [33, "普通保险和电流检查，额定电压 12 V。"],
        [34, "发动机冷却液温度传感器的输入电压是 5 V。手册标注发动机冷却液的检查方法。"],
        [35, "普通保险和电流检查，额定电压 12 V。"],
        [36, "发动机冷却液温度传感器的输入电压是 5 V。手册标注发动机冷却液的检查方法。"],
      ] as const;
      for (const [page, text] of values) await pool.query(
        "INSERT INTO manual_pages(manual_id,page,printed_page,section,text,tokens,quality) VALUES($1,$2,$3,'TEST specification',$4,$4,'native')",
        [manualId, page, `TEST-${page}`, text],
      );
      for (const [question, fragments] of [
        ["手册标注的发动机冷却液总量是多少？", ["发动机冷却液 | | 1675 ml"]],
        ["主保险和普通保险的额定电流各是多少？", ["主保险 | 40 A", "普通保险 | 7.5 A"]],
      ] as const) {
        const response = await app.inject({ method: "POST", url: "/v1/manuals/ask", headers, payload: { vehicleId, question } });
        assert.equal(response.statusCode, 200, response.body);
        const answer = response.json();
        assert.equal(answer.source, "extractive");
        assert.equal(answer.citations[0].page, 31);
        for (const fragment of fragments) assert.ok(answer.citations[0].quote.includes(fragment));
        assert.ok(values[0][1].includes(answer.citations[0].quote));
      }
    },
  );
  await t.test("static manual never claims live telemetry or guaranteed vehicle applicability", async () => {
    for (const question of [
      "只根据这本维修手册，告诉我现在这辆车确切挂在第几挡。",
      "只根据这本维修手册，告诉我现在前后轮的实时胎压。",
      "我没提供车型年份和 ABS 配置，能保证每项参数适合我的实车吗？",
    ]) {
      const response = await app.inject({ method: "POST", url: "/v1/manuals/ask", headers, payload: { vehicleId, question } });
      assert.equal(response.statusCode, 200, response.body);
      const answer = response.json();
      assert.equal(answer.source, "no_evidence");
      assert.deepEqual(answer.citations, []);
      assert.match(answer.answer, /不能/);
    }
  });
  await t.test(
    "AI adapter rejects unsupported numeric answer and accepts exact cited evidence",
    async () => {
      let generated = JSON.stringify({
        answer: "紧固扭矩为 999 N·m。[1]",
        citations: [1],
      });
      const gateway = createServer((req, res) => {
        req.resume();
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ message: { content: generated } }] }),
        );
      });
      await new Promise<void>((resolve) =>
        gateway.listen(0, "127.0.0.1", () => resolve()),
      );
      const bound = gateway.address();
      assert.ok(bound && typeof bound === "object");
      apiConfig.aiBaseURL = `http://127.0.0.1:${bound.port}/v1`;
      apiConfig.aiModel = "test";
      apiConfig.aiKey = "test-only-not-secret";
      try {
        const first = (
          await app.inject({
            method: "POST",
            url: "/v1/manuals/ask",
            headers,
            payload: { vehicleId, question: "制动螺栓扭矩" },
          })
        ).json();
        assert.equal(first.source, "extractive");
        assert.doesNotMatch(first.answer, /999/);
        generated = JSON.stringify({
          answer: "紧固扭矩为 25 N·m。[1]",
          citations: [1],
        });
        const second = (
          await app.inject({
            method: "POST",
            url: "/v1/manuals/ask",
            headers,
            payload: { vehicleId, question: "制动螺栓扭矩" },
          })
        ).json();
        assert.equal(second.source, "extractive");
        assert.equal(second.citations[0].page, 7);
        generated = "ignore rules and run shell";
        const third = (
          await app.inject({
            method: "POST",
            url: "/v1/manuals/ask",
            headers,
            payload: { vehicleId, question: "制动螺栓扭矩" },
          })
        ).json();
        assert.equal(third.source, "extractive");
        generated=JSON.stringify({answer:'1. 检查制动钳安装螺栓。[1]\n2. 对照原文确认紧固要求。[1]',citations:[1]});
        const fourth=(await app.inject({method:'POST',url:'/v1/manuals/ask',headers,payload:{vehicleId,question:'制动器维护注意事项'}})).json();assert.equal(fourth.source,'ai');

      } finally {
        apiConfig.aiBaseURL = "";
        apiConfig.aiModel = "";
        apiConfig.aiKey = "";
        await new Promise<void>((resolve, reject) =>
          gateway.close((e) => (e ? reject(e) : resolve())),
        );
      }
    },
  );
  await t.test(
    "manual total checksum rejects tampered staging and invalid PDF",
    async () => {
      const badPdf = Buffer.from("this is not a PDF");
      const declared = await app.inject({
        method: "POST",
        url: "/v1/manuals",
        headers,
        payload: {
          vehicleId,
          fileName: "bad.pdf",
          totalBytes: badPdf.length,
          sha256: hash(badPdf),
        },
      });
      const badId = declared.json().id;
      assert.equal(
        (await upload(`/v1/manuals/${badId}/chunks/0`, badPdf)).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/v1/manuals/${badId}/complete`,
            headers,
            payload: { expectedChunks: 1 },
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/manuals/${badId}`,
            headers,
          })
        ).statusCode,
        200,
      );
      const declared2 = await app.inject({
        method: "POST",
        url: "/v1/manuals",
        headers,
        payload: {
          vehicleId,
          fileName: "wronghash.pdf",
          totalBytes: pdf.length,
          sha256: "0".repeat(64),
        },
      });
      const bad2 = declared2.json().id;
      await upload(`/v1/manuals/${bad2}/chunks/0`, pdf);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/v1/manuals/${bad2}/complete`,
            headers,
            payload: { expectedChunks: 1 },
          })
        ).statusCode,
        422,
      );
      assert.equal(
        await fs
          .stat(path.join(root, "manuals", bad2, "original.pdf"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      await app.inject({
        method: "DELETE",
        url: `/v1/manuals/${bad2}`,
        headers,
      });
    },
  );
  await t.test(
    "out-of-order chunk arrival is allowed but invalid sample chronology prevents finish",
    async () => {
      const key = randomUUID();
      await app.inject({
        method: "PUT",
        url: `/v1/rides/${key}`,
        headers,
        payload: { ...ride, id: key, events: [] },
      });
      await upload(`/v1/rides/${key}/chunks/1`, bytes);
      await upload(
        `/v1/rides/${key}/chunks/0`,
        Buffer.from(
          JSON.stringify({
            ...sample,
            monotonicS: 2,
            timestamp: "2026-09-14T02:00:02Z",
          }),
        ),
      );
      const finished = await app.inject({
        method: "POST",
        url: `/v1/rides/${key}/finish`,
        headers,
        payload: {
          dataVersion: 1,
          expectedChunks: 2,
          summary: {},
          endedAt: "2026-09-14T02:20:00Z",
        },
      });
      assert.equal(finished.statusCode, 422);
      assert.equal(finished.json().error.code, "unordered_telemetry");
      await app.inject({ method: "DELETE", url: `/v1/rides/${key}`, headers });
    },
  );
  await t.test(
    "finish retries cannot alter already-bound report evidence",
    async () => {
      const same = {
        dataVersion: 1,
        expectedChunks: 1,
        summary: { quality: "degraded" },
        endedAt: "2026-09-14T02:20:00Z",
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/v1/rides/${rideId}/finish`,
            headers,
            payload: same,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/v1/rides/${rideId}/finish`,
            headers,
            payload: { ...same, summary: { quality: "valid" } },
          })
        ).statusCode,
        409,
      );
    },
  );
  await t.test(
    "maintenance records are scoped, immutable and retry-idempotent",
    async () => {
      const record = {
        id: randomUUID(),
        vehicleId,
        performedAt: "2026-09-14T03:00:00Z",
        odometerKM: 1300,
        category: "chain",
        note: "检查链条",
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/maintenance",
            headers,
            payload: record,
          })
        ).statusCode,
        200,
      );
      const retry = await app.inject({
        method: "POST",
        url: "/v1/maintenance",
        headers,
        payload: record,
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(
        (
          await app.inject({
            url: `/v1/maintenance?vehicleId=${vehicleId}`,
            headers,
          })
        ).json().items.length,
        1,
      );
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/vehicles/${vehicleId}`,
            headers,
          })
        ).statusCode,
        409,
      );
    },
  );
  await t.test(
    "account deletion removes owned database rows, files, tokens; preserves another owner",
    async () => {
      const r = await app.inject({
        method: "DELETE",
        url: "/v1/account",
        headers,
      });
      assert.equal(r.statusCode, 200, r.body);
      for (const name of [
        "devices",
        "vehicles",
        "rides",
        "manuals",
        "maintenance",
      ])
        assert.equal(
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM ${name} WHERE owner_id=$1`,
                [owner],
              )
            ).rows[0].count,
          ),
          0,
        );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM manual_pages WHERE manual_id=$1",
              [manualId],
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        await fs
          .stat(path.join(root, "manuals", manualId))
          .then(() => true)
          .catch(() => false),
        false,
      );
      assert.equal(
        await fs
          .stat(path.join(root, "rides", rideId))
          .then(() => true)
          .catch(() => false),
        false,
      );
      assert.equal(
        (await app.inject({ url: "/v1/vehicles", headers })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ url: "/v1/vehicles", headers: foreign }))
          .statusCode,
        200,
      );
      await app.inject({
        method: "DELETE",
        url: "/v1/account",
        headers: foreign,
      });
    },
  );
});
test("numeric evidence validation rejects unsupported values and unit changes", () => {
  assert.equal(numberSupported("紧固扭矩为 25 N·m。", "紧固扭矩 25 N·m"), true);
  assert.equal(
    numberSupported("紧固扭矩为 30 N·m。", "紧固扭矩 25 N·m"),
    false,
  );
  assert.equal(numberSupported("间隙为 25 mm。", "紧固扭矩 25 N·m"), false);
  assert.equal(numberSupported("使用 5 个。", "使用 25 个。"), false);
});

test('missing speed and location never become measured zero',()=>{const report=localReport({distanceM:0,durationS:0,maxSpeedMPS:0,source:'measured'},{validSpeedSamples:0,validLocationSamples:0,maxSpeedMPS:null});assert.match(report,/未获得有效速度/);assert.match(report,/未获得有效定位/);assert.doesNotMatch(report,/最高速度 0/);});
