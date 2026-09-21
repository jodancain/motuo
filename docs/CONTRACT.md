# Motuo v1 integration contract

## Transport

API root https://motuo.example.com/v1 (replace with your own deployed domain). JSON camelCase, ISO8601 UTC timestamps, UUID strings. Authorization Bearer device token. API success is the object itself (no extra data envelope); errors `{error:{code,message}}`. All user resources scoped by authenticated owner. Pairing establishes first owner's device; no public registration.

- POST /v1/pair `{code,deviceName}` -> `{token,deviceId,ownerId}`
- GET /v1/capabilities -> `{ai:{configured},navigation:{provider:"amap",embeddedEnabled:false},version}`
- GET /v1/vehicles -> `{items:[Vehicle]}`; PUT /v1/vehicles/:id body Vehicle; DELETE /v1/vehicles/:id.
- Vehicle `{id,name,make,model,year:null|number,abs:null|boolean,displacementCC,plate,tyres,modifications,odometerKM}`; default Suzuki GSX250R, 248 cc. Vehicle ID generated client-side.
- GET /v1/rides -> `{items:[Ride]}`; PUT /v1/rides/:id body Ride; GET /v1/rides/:id; DELETE /v1/rides/:id.
- Ride `{id,vehicleId,startedAt,endedAt:null|string,status:"recording"|"paused"|"finished"|"interrupted",source:"measured"|"simulated",distanceM,durationS,maxSpeedMPS,meanSpeedMPS,dataVersion,events:[],summary:{}}`.
- PUT /v1/rides/:id/chunks/:sequence: raw application/octet-stream JSONL UTF8, header X-Content-SHA256; content lines TelemetrySample, max 4 MiB; chunk atomically stored by ride+sequence+hash; conflicting duplicate 409.
- POST /v1/rides/:id/finish `{dataVersion,expectedChunks,summary,endedAt}` -> `{status,reportStatus}`; absent chunks 409. GET /v1/rides/:id/report -> `{status:"pending"|"ready"|"failed"|"unavailable",dataVersion,source:"ai"|"local",text,createdAt?}`.
- POST /v1/rides/:id/events/:eventId/feedback `{label:"confirmed"|"rejected",note}` retains original event window.
- GET /v1/manuals?vehicleId=... -> `{items:[Manual]}`; POST /v1/manuals `{vehicleId,fileName,totalBytes,sha256}` -> `{id,chunkSize:4194304,status}`. Client uploads raw 4 MiB chunks PUT /v1/manuals/:id/chunks/:sequence with SHA256 header, then POST /v1/manuals/:id/complete `{expectedChunks}`. GET /v1/manuals/:id -> Manual; DELETE /v1/manuals/:id.
- Manual `{id,vehicleId,fileName,totalBytes,pageCount,status:"uploading"|"queued"|"processing"|"ready"|"failed",progress,error?}`. GET /v1/manuals/:id/file returns authenticated original PDF supporting byte ranges.
- POST /v1/manuals/ask `{vehicleId,question}` -> `{answer,source:"ai"|"extractive"|"no_evidence",citations:[{manualId,fileName,page,printedPage,section,quote}],limitations:[]}`. Citation page is 1-based physical PDF page.
- GET /v1/maintenance?vehicleId= -> `{items:[]}`; POST /v1/maintenance `{vehicleId,id,performedAt,odometerKM,category,note}`.
- DELETE /v1/account deletes this owner's resources and tokens.

TelemetrySample JSONL: `{timestamp:ISO8601,monotonicS:number,stream?:"location"|"motion"|"simulation",segmentId?:UUID,source:"measured"|"simulated",speedMPS?:number,latitude?:number,longitude?:number,horizontalAccuracyM?:number,speedAccuracyMPS?:number,accelerationX?:number,accelerationY?:number,accelerationZ?:number,rotationX?:number,rotationY?:number,rotationZ?:number,rollRad?:number,quality:"valid"|"degraded"|"unavailable",calibrationId?:string}`. Missing values omitted, never zeros. Location WGS84; map adapters convert explicitly. New clients always provide stream and segmentId together. monotonicS is elapsed sampling time within that continuous recording segment, never raw device uptime: motion derives it from hardware-clock differences; GPS has no hardware monotonic timestamp and derives it from the original CLLocation timestamp relative to the segment wall anchor; simulation uses local elapsed time. timestamp preserves the original location capture time, or the wall anchor plus hardware elapsed time for motion. A new segment UUID is created on start, resume, crash recovery, or significant system clock change. Samples predating the current segment and duplicate/older samples within one stream are discarded rather than assigned a fabricated time. Server validation is non-decreasing within each (segmentId,stream), including across chunks; cross-stream callback ordering is unrestricted. Legacy samples without stream/segmentId retain their original times and are not subjected to cross-stream ordering. stream=simulation requires source=simulated. Requested frequency is not asserted sampling rate.

## Backend/worker shared storage

Server owns schema migration and creates manual tables. Python worker claims queued jobs from PostgreSQL with SKIP LOCKED, processes one PDF at a time.

`manuals`: id UUID PK, owner_id UUID NOT NULL, vehicle_id UUID, file_name TEXT, total_bytes BIGINT, sha256 TEXT, status TEXT, progress INTEGER DEFAULT 0, page_count INTEGER DEFAULT 0, error TEXT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now().

`manual_pages`: manual_id UUID REFERENCES manuals ON DELETE CASCADE, page INTEGER, printed_page TEXT, section TEXT, text TEXT, tokens TEXT, quality TEXT, PRIMARY KEY(manual_id,page). Worker inserts/updates pages and publishes ready only after complete. Chinese search uses tokens/simple tsvector and fallback exact character terms, retaining all original numbers. Server serves only ready, scoped manuals.

Shared DATA_DIR default ./data (container /data): manuals/{manualId}/original.pdf; manual upload staging under uploads/manuals/{manualId}/; rides/{rideId}/chunks/{sequence}.jsonl. Never concatenate caller-provided paths without UUID/sequence validation. PDF max 256 MiB, 1000 pages. Original immutable after checksum validation. Worker must check deleted jobs before commit, bound OCR/runtime, and report interrupted processing.

AI configured server-side AI_BASE_URL/AI_MODEL/AI_API_KEY. Absent/unavailable provider gives truthful local/extractive result. Manual text is untrusted evidence, not instructions; no execution tools. Numbers in answers require exact cited source support. Reports bind to immutable ride dataVersion.

## iOS ownership

iOS main agent owns app, model, sensor engine, telemetry files, SwiftData, UI, Watch, XcodeGen project and tests. Parent owns `ios/Motuo/Integrations/` (MusicService.swift, NavigationService.swift, APIClient.swift, AccessoryService.swift), app icons and deployment/signing scripts. Shared service API supplied by parent. Agent may add UI around these services after confirming interface.
