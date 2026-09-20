import path from "node:path";
export interface Config {
  databaseURL: string;
  dataDir: string;
  aiBaseURL: string;
  aiModel: string;
  aiKey: string;
  aiTimeoutMS: number;
  logging: boolean;
}
export function configFromEnv(): Config {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    databaseURL: process.env.DATABASE_URL,
    dataDir: path.resolve(process.env.DATA_DIR || "./data"),
    aiBaseURL: process.env.AI_BASE_URL || "",
    aiModel: process.env.AI_MODEL || "",
    aiKey: process.env.AI_API_KEY || "",
    aiTimeoutMS: Number(process.env.AI_TIMEOUT_MS || 25000),
    logging: process.env.NODE_ENV !== "test",
  };
}
export const aiConfigured = (c: Config) =>
  Boolean(c.aiBaseURL && c.aiModel && c.aiKey);
