import pg from "pg";
import { platform } from "./env.js";
import { SCHEMA, SCHEMA_VERSION } from "./schema.js";

// DATE columns as 'YYYY-MM-DD' strings (no timezone shifts).
pg.types.setTypeParser(1082, (v) => v);
// COUNT(*) etc. as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

let pool: pg.Pool | undefined;
let ready: Promise<void> | undefined;

async function connectionString() {
  if (platform.databaseUrl) return platform.databaseUrl;
  try {
    // Netlify Database (credit-based plans): resolved at runtime when installed.
    const mod: any = await import(/* @vite-ignore */ "@netlify/database" as string);
    return mod.getConnectionString() as string;
  } catch {
    throw new Error("No database configured: set DATABASE_URL");
  }
}

async function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: await connectionString(), max: 4, idleTimeoutMillis: 10_000 });
    pool.on("error", (e) => console.error("[db] idle client error", e.message));
  }
  return pool;
}

/** Applies the schema once per process (cheap version check after the first time). */
export function ensureSchema() {
  ready ??= (async () => {
    const p = await getPool();
    const current = await p.query(`SELECT value FROM platform_meta WHERE key='schema_version'`).catch(() => null);
    if (current?.rows[0]?.value === String(SCHEMA_VERSION)) return;
    const client = await p.connect();
    try {
      await client.query("SELECT pg_advisory_lock(424242)");
      await client.query(SCHEMA);
      await client.query(
        `INSERT INTO platform_meta (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(SCHEMA_VERSION)]);
    } finally {
      await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
      client.release();
    }
  })().catch((e) => { ready = undefined; throw e; });
  return ready;
}

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  return (await (await getPool()).query<T>(sql, params)).rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
  return (await query<T>(sql, params))[0] as T | undefined;
}

export async function tx<T>(fn: (q: <R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>) {
  await ensureSchema();
  const client = await (await getPool()).connect();
  try {
    await client.query("BEGIN");
    const r = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
  ready = undefined;
}
