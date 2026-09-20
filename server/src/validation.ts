import { z } from "zod";
export const uuid = z.string().uuid().transform(value=>value.toLowerCase());
export const iso = z.string().datetime({ offset: true });
const positive = z.number().finite().nonnegative();
export const vehicle = z.object({
  id: uuid,
  name: z.string().min(1).max(100),
  make: z.string().max(100),
  model: z.string().max(100),
  year: z.number().int().min(1900).max(2100).nullable().default(null),
  abs: z.boolean().nullable().default(null),
  displacementCC: positive.max(10000),
  plate: z.string().max(80).default(""),
  tyres: z.union([z.string().max(4000), z.record(z.unknown())]).default(""),
  modifications: z
    .union([z.string().max(8000), z.array(z.string().max(1000))])
    .default(""),
  odometerKM: positive,
});
export const ride = z.object({
  id: uuid,
  vehicleId: uuid,
  startedAt: iso,
  endedAt: iso.nullable(),
  status: z.enum(["recording", "paused", "finished", "interrupted"]),
  source: z.enum(["measured", "simulated"]),
  distanceM: positive,
  durationS: positive,
  maxSpeedMPS: positive.max(150),
  meanSpeedMPS: positive.max(150),
  dataVersion: z.number().int().min(1).max(2147483647),
  events: z
    .array(z.object({ id: uuid }).passthrough())
    .max(5000)
    .default([]),
  summary: z.record(z.unknown()).default({}),
});
export const sample = z
  .object({
    timestamp: iso,
    monotonicS: positive,
    stream: z.enum(["location", "motion", "simulation"]).optional(),
    segmentId: uuid.optional(),
    source: z.enum(["measured", "simulated"]),
    speedMPS: positive.max(150).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    horizontalAccuracyM: z.number().finite().optional(),
    speedAccuracyMPS: z.number().finite().optional(),
    accelerationX: z.number().finite().optional(),
    accelerationY: z.number().finite().optional(),
    accelerationZ: z.number().finite().optional(),
    rotationX: z.number().finite().optional(),
    rotationY: z.number().finite().optional(),
    rotationZ: z.number().finite().optional(),
    rollRad: z.number().finite().optional(),
    quality: z.enum(["valid", "degraded", "unavailable"]),
    calibrationId: z.string().max(100).optional(),
  })
  .strict()
  .superRefine((s,ctx)=>{
    if(Boolean(s.stream)!==Boolean(s.segmentId))ctx.addIssue({code:z.ZodIssueCode.custom,message:"stream and segmentId must be supplied together"});
    if(s.stream==="simulation" && s.source!=="simulated")ctx.addIssue({code:z.ZodIssueCode.custom,message:"simulation stream must be labelled simulated"});
  });
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new APIError(status, code, message);
};
export function id(value: unknown) {
  return uuid.parse(value);
}
export function seq(value: unknown) {
  const raw = String(value);
  if (!/^(0|[1-9]\d{0,5})$/.test(raw))
    fail(400, "invalid_sequence", "Invalid chunk sequence");
  return Number(raw);
}

export type TelemetrySample=z.infer<typeof sample>;
export type StreamClock=Map<string,{monotonicS:number;timestamp:string}>;
export function assertStreamOrder(samples:TelemetrySample[],last:StreamClock=new Map()):void {
  for(const s of samples){
    // Older clients did not distinguish sensor clocks; never invent cross-stream ordering.
    if(!s.stream || !s.segmentId)continue;
    const key=s.segmentId+":"+s.stream,previous=last.get(key);
    if(previous && (s.monotonicS<previous.monotonicS || Date.parse(s.timestamp)<Date.parse(previous.timestamp)))fail(422,"unordered_telemetry","Sample time moved backwards within the same sensor stream and recording segment");
    last.set(key,{monotonicS:s.monotonicS,timestamp:s.timestamp});
  }
}
