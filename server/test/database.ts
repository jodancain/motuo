import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** Each suite owns its database so a background job cannot claim another suite's files. */
export async function isolatedTestDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('Run npm run test:integration');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const name = `motuo_suite_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async close() {
      try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally { await admin.end(); }
    },
  };
}
