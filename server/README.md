# Motuo API

TypeScript / Fastify / PostgreSQL. This service implements `../docs/CONTRACT.md`; the Python worker owns PDF text extraction and OCR. No manual, private route data, pairing codes or provider secrets belong in Git.

## Run

Node.js 22+ and PostgreSQL 15+ (tests also run on local PostgreSQL 14).

```sh
npm ci
export DATABASE_URL='postgresql://motuo:YOUR_PASSWORD@127.0.0.1:5432/motuo'
export DATA_DIR='/absolute/private/motuo-data'
npm run migrate
npm run dev
```

Copy `.env.example` to private deployment configuration; the API reads process environment and does not automatically load `.env`. Containers default to port 3020 and `/data`. At startup the server runs idempotent `schema.sql` under a PostgreSQL advisory migration lock. The worker must start after this schema is initialized. `GET /healthz` performs a real database check. All `/v1` endpoints require a device bearer token except `/v1/pair`.

## First device and subsequent devices

```sh
npm run pair
# Compiled Docker image equivalent:
node dist/src/bootstrap.js
```

The command creates an owner and a cryptographically random, one-use pairing code valid for 15 minutes. For another device on the same account set `OWNER_ID` to that owner's UUID when invoking it. The printed code is a credential: deliver it only to the user; do not save it in logs or documentation. POST the code and a device name to `/v1/pair`. Only hashes of the code and issued device token are stored. App tokens should stay in iOS Keychain. Pairing requests are limited to 10 per minute per source address, independently of the API's overall 240/minute budget.

## Persistence and ownership

Every authenticated resource is scoped to the token's owner. Cross-owner reads/changes return 404; pairing is the only account creation entry. Clients generate vehicle, ride, event and maintenance UUIDs. `dataVersion` starts at 1. Finished ride records and existing chunks cannot be silently rewritten. Maintenance records accept exact retries, while changed duplicates return 409. Vehicle deletion returns 409 while rides/manuals/maintenance reference it.

`schema.sql` defines server-owned tables and the exact worker `manuals` / `manual_pages` contract. API and worker share a private writable `DATA_DIR`; they must have compatible volume ownership. `original.pdf` is only published after all declared chunks pass their own checksum, expected lengths and total SHA-256. File names supplied by callers never select storage paths. Reads use UUIDs and integer chunk sequences.

Rides use raw UTF-8 JSONL `application/octet-stream` chunks, zero-based consecutive sequence numbers and `X-Content-SHA256`. Each chunk is at most 4 MiB, validates TelemetrySample structure, and retains measured/simulated labels. `/finish` checks exact chunk count, checksum and sensor-stream/recording-segment timestamp ordering across boundaries (cross-sensor callback order and new recording segments may reset; unidentified legacy streams are preserved without invented global ordering) before fixing `dataVersion`. Reports are queued in PostgreSQL, claimed with `FOR UPDATE SKIP LOCKED`, and recovered after a stale processing lease. A report update cannot attach to a different finalized version.

Manual uploads are capped at 256 MiB, 4 MiB per chunk, 20 unfinished imports per owner. The worker enforces 1000 pages, one PDF per process and processing time/OCR limits. `queued` and `processing` are real asynchronous states. Authenticated `/file` serves the verified original, including single and suffix byte ranges; invalid/multiple ranges return 416.

Deletes commit the database changes before removing directories. Pending filesystem deletion is recorded in `file_cleanup` and retried in the background. Account deletion removes owned resources, cascades device tokens and knowledge pages, and queues all file directories for removal. Another owner's account is preserved.

## AI and evidence

Set `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` only on the server. The gateway uses the OpenAI-compatible chat completion interface; no API key is shipped to iOS. Reports produce an explicitly local summary if AI is missing, unavailable or fails numeric evidence validation. They never fill missing RPM, gear, vehicle fault or calibrated lean accuracy.

`/v1/manuals/ask` searches only ready manuals for the selected owned vehicle. Chinese exact-character/bigram matches are combined with PostgreSQL simple text indexing over worker tokens. Returned citations retain original text, 1-based physical PDF page, printed page and section. AI must return a validated JSON answer and real citation IDs; numbered source markers and list numbering are parsed independently. Parameter questions (torque, clearance, fluid amount, pressure, specifications) immediately return exact extracts; generated answers containing numeric parameter claims also fall back to original text. String matching alone is not a proof of the relationship between a parameter and its value. Invalid or unsupported AI responses fall back to exact extracts. OCR and low-quality text add a request to verify numeric/table content against the original page. No matching source returns `no_evidence`. This validates textual support, not the real motorcycle's condition or a causal diagnosis.

Imported manual text and user riding notes are untrusted evidence. They do not become system instructions, tool calls or executable code.

## Verify

```sh
npm run check
npm run build
npm run test:integration
```

`test:integration` creates a private temporary PostgreSQL instance on a dynamically chosen loopback port and stops/removes only that instance afterward. It does not connect to an existing production database. Override `PG_BIN` for another local Postgres installation. Each integration suite creates a separate temporary database, closes its connections, then drops only that database. For an explicitly disposable test PostgreSQL instance, set `TEST_DATABASE_URL`; the test role needs `CREATEDB` permission. Never set it to a production connection. Tests use real PostgreSQL and real filesystem storage. Synthetic PDF page rows in API tests validate API retrieval; the worker has separate extraction/OCR tests. OpenAPI is in `openapi.json`.

NAS/public routing, iOS/watchOS hardware, real gateway generation and TestFlight are independent checks; a successful local API test does not demonstrate them.
