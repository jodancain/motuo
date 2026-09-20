# Motuo NAS deployment and acceptance

Status (2026-09-20): the first readback found release `v010-20260914-a4` running, PostgreSQL/API healthy, and both `a5` images already built. The original manual import had failed after 175 published pages. During investigation the NAS Tailscale peer became offline; direct SSH and Shanghai-to-NAS HTTP subsequently timed out. No release switch or recovery mutation was made on this date. The 2026-09-14 AI/smoke results below remain historical evidence, not a new availability claim. Public TLS and TestFlight have separate acceptance gates.

## Isolated runtime

The project lives at `/volume1/docker/motuo` on Synology NAS `100.74.46.95`. PostgreSQL has its own `motuo-postgres` container and private volume. API and PDF worker share only Motuo's data volume as UID 1000. No MedAgent business data, image, container or route has been changed.

The `motuo-net` bridge uses verified free subnet `172.30.110.0/24`; the NAS default Docker address pools are exhausted. PostgreSQL has no published port. The API is published only at `127.0.0.1:3020`: NAS Tailscale has no host interface carrying `100.74.46.95`, so binding that address failed. Despite that, the actual Shanghai-to-NAS request `http://100.74.46.95:3020/healthz` returns HTTP 200 through the existing Tailscale userspace network. No extra Serve mapping or LAN/public wildcard binding was needed or added. The Serve configuration remains unchanged.

DSM's kernel rejected CPU CFS quotas and discarded PID limits. These unsupported declarations were removed. API/PostgreSQL memory limits are 512 MiB each and worker memory is 1536 MiB. The worker processes one PDF at a time with `OMP_THREAD_LIMIT=1`. CPU/PID isolation is not claimed.

## Verified evidence

- Local `npm run check`, `npm run test:integration`, `npm run build`: rerun on 2026-09-20, 36 passing tests with no skips, including real PostgreSQL/filesystem/TCP HTTP. Every integration suite creates its own disposable database so jobs cannot claim another suite's files.
- NAS API `/healthz`: HTTP 200, `status=ok`, `service=motuo-api`, `version=0.1.0`. Shanghai readback to Tailscale port 3020 returns the same JSON.
- `docs/nas-smoke.json`: actual NAS HTTP pairing, authentication, vehicle/ride creation, checksum rejection, retry idempotency, missing-chunk 409, asynchronous report, provenance, feedback, maintenance, no-evidence behavior and account/file/token cleanup all passed. The report source was `ai`; the tested input was synthetic. The synthetic account was removed afterward.
- `docs/nas-ai-canary.json`: actual provider HTTP 200 with exact expected synthetic response; no account, route, location or manual contents used. This demonstrates connectivity separately from repair-answer accuracy.
- Worker dependency is pinned to non-yanked `pypdfium2==4.30.0`. Original-manual extraction, retrieval evidence and limits are documented in `docs/manual-acceptance.md`.

## Operations and private material

Deployment tooling: `scripts/deploy-nas.py`. Immutable release directories and tagged images are retained under `/volume1/docker/motuo/releases/`. Source hash manifests are local in `.private/nas-release-state.json`.

The runtime `.env` is mode 0600 under the mode-0700 Motuo root. Provider credentials were copied in memory from the explicitly authorized existing configuration and never printed or committed.

Personal device pairing material is in `.private/nas-pairing.json`; its one-time code expires after 15 minutes. `python3 scripts/deploy-nas.py pair` generates another code for the same owner. The separate integration device token is in `.private/nas-client.json`, mode 0600. `scripts/nas-client.py` creates/retrieves that integration token without consuming the user-facing pairing code. These files are gitignored. Never paste their contents into logs or documentation.

## Backup and rollback gates

`deploy/nas-backup-verify.py` briefly pauses only Motuo API/worker writes, saves a PostgreSQL custom dump and a hash-checked private data archive, unpauses, and restores to a disposable PostgreSQL container with `--network none`. Verification compares all table row counts/content hashes and every file's bytes/SHA-256. The uniquely named restore container/directory is removed; private backups remain on the NAS. This is not an off-NAS backup.

`deploy/nas-rollback-verify.py --previous RELEASE` refuses to run while uploads or jobs remain pending. It runs the retained previous API/worker image, verifies health and unchanged database contents, then restores the final release in a `finally` block and verifies both final image IDs. Backup and rollback execution will be recorded after the complete original manual has reached `ready`; empty-database restoration is not accepted as the final evidence.

## 2026-09-20 recovery checkpoint

- Last successful runtime readback: API `motuo-api:v010-20260914-a4`, image `sha256:31e6eaaf2aadeddc696f48c7d39716bc9da8fb7a038f048e03bb710f02495723`; worker `motuo-worker:v010-20260914-a4`, image `sha256:17a0189b4e686419cdac8fc0a8e80670b27df019cb56618d3c78485eaacd61b6`. Both were running. PostgreSQL was healthy and had no exposed port.
- Built API image `motuo-api:v010-20260914-a5` is `sha256:d369c37afc406ecc91ce865bf330764d588c3b6ec858e259dc70a61a68aee374`; its worker image is identical to the above worker. The private source manifest matched server and worker source at this checkpoint; any parser fix must receive a new release tag before deployment.
- The original manual remains at its existing manual ID and owner. Its database status is `failed`, progress `28`, page count `616`, with 175 committed page rows and `PDF_EXTRACTION_FAILED:PdfminerException`. The source PDF, owner, device token and page evidence were not deleted or replaced. The same pinned dependencies successfully processed physical page 176 and all 616 pages locally; this did not reproduce or explain the NAS failure. NAS cause inspection is still required before requeueing the same import.
- Local worker hardening on 2026-09-20 preserves a parser-wrapped timeout as a page-specific failure, and uses page-level OCR with `needs_review` only for genuine parser exceptions. It passed 21 tests including actual PostgreSQL/OCR. The final 616-page JSONL is byte-identical to the pinned-dependency pre-fix reference, with all 41 source questions passing. These source changes are not present in either existing NAS worker image and require a new release tag; no NAS fix is claimed.
- Subsequent independent `ssh -S none` to the NAS and Tailscale pings from Mac/Shanghai timed out; Shanghai's peer readback reported `university` / `100.74.46.95` as `Online=false`. No shared networking service was restarted or modified.
- A bounded fallback check found historical NAS LAN address `192.168.5.10` in the local SSH known-hosts file with the same registered host key as `100.74.46.95`. The Mac was on `172.20.10.2/28`, not that LAN, with an existing `utun11` route to `192.168.5.0/24`. Strict-host-key SSH and TCP checks to this one known address on ports 22/5001 timed out; the existing `nas-via-shanghai` SSH route also timed out. No subnet scan, route change or shared-service restart was attempted. This establishes unavailable paths, not that the NAS is powered off.
- Still required after NAS connectivity returns: inspect the parser cause, complete the existing original import, deploy the verified final image, run the 41 cited questions plus 3 no-evidence boundaries on the actual NAS, rerun the synthetic AI canary, then verify backup restore and final→a4→final rollback with all 616 pages present.

## 2026-09-20 14:26–14:29 CST: bounded reachability recheck

- NAS peer `university` remained `Online=false`, `LastSeen=2026-09-20T03:00:00.1Z`. Direct SSH, the existing Shanghai SSH jump route, and known LAN `192.168.5.10` ports 22/5001 all timed out. Shanghai itself remained reachable.
- Public resolver `119.29.29.29`, queried from Shanghai at 14:27 CST, still returned NXDOMAIN for `motuo.yundongyl.cn`; the existing Shanghai HTTP Host placeholder returned 503. The Mac's `198.18.3.86` answer came from its local proxy DNS and is not a verified public A record.
- A narrow read-only check of known project notes, SSH configuration and Synology Drive connection metadata found only NAS `100.74.46.95:6690`; QuickConnect/domain/tunnel fields were empty. No alternate remote address was discovered. The user-mentioned alternate DSM/QuickConnect URL or restored NAS connectivity is still needed. No subnet scan, route/service change, remote write or inference that the NAS is powered off was made.

## Controlled failed-import retry: local delivery, not deployed

`worker/motuo_worker/retry.py` adds an operator-only command, dry-run by default. An explicit `--apply` may queue one failed original import only after exact manual/owner UUID, expected source SHA/bytes, actual PDF integrity and every committed contiguous DB/sidecar page pass validation. It preserves the source and committed pages, rejects unsafe paths/symlinks and corruption, and never creates a manual. Queued/processing/ready calls are metadata-only no-ops. Row/advisory lock ordering matches the worker and protects against deletion races; no automatic or bulk retry was introduced.

The worker suite now passes 38/38 tests (17 added retry scenarios), including real PostgreSQL/OCR. An independent review found no actionable P0/P1/P2 finding across retry, worker publication and server deletion paths. See `worker/README.md` for the exact command and interpretation. This is local tool/test evidence only: it has not been deployed or run against the failed NAS import. Diagnose the actual parser cause and back up Motuo first, use a new immutable release tag, then dry-run/apply on the original import and separately verify 616-page ready, cited questions, AI and backup/rollback gates.

The accepted product direction now uses a separate HTML prototype for feedback before any native change. Future maps use MapLibre, regional OSM/Martin, Valhalla and Ferrostar; these services are not currently deployed. The existing TestFlight 0.1.0 (1) still uses external AMap, and no new native build was produced in this round.
