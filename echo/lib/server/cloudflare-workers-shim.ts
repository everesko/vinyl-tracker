import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS echo_collections (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  subtitle text NOT NULL,
  track_ids text NOT NULL,
  track_data text,
  recipe text,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS echo_collections_user_created ON echo_collections (user_id, created_at);

CREATE TABLE IF NOT EXISTS echo_games (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  collection_id text NOT NULL,
  collection_title text NOT NULL,
  state text NOT NULL,
  version integer DEFAULT 0 NOT NULL,
  finished integer DEFAULT 0 NOT NULL,
  score_tenths integer DEFAULT 0 NOT NULL,
  correct integer DEFAULT 0 NOT NULL,
  total integer NOT NULL,
  xp real DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS echo_games_user_updated ON echo_games (user_id, updated_at);

CREATE TABLE IF NOT EXISTS echo_spotify_connections (
  user_id text PRIMARY KEY NOT NULL,
  encrypted_tokens text NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS echo_media_collections (
  id text PRIMARY KEY NOT NULL,
  track_data text NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS echo_settings (
  user_id text PRIMARY KEY NOT NULL,
  encrypted_settings text NOT NULL,
  version integer DEFAULT 0 NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS echo_profile_balances (
  user_id text PRIMARY KEY NOT NULL,
  offset_tenths integer DEFAULT 0 NOT NULL,
  reset_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS echo_progression (
  user_id text PRIMARY KEY NOT NULL,
  spent_tenths integer DEFAULT 0 NOT NULL,
  unlocks text DEFAULT '{}' NOT NULL,
  practice integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS echo_vinyl_connections (
  user_id text NOT NULL,
  provider text NOT NULL,
  encrypted_connection text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY(user_id, provider)
);

CREATE TABLE IF NOT EXISTS echo_vinyl_tables (
  user_id text NOT NULL,
  mode text NOT NULL,
  tables_json text NOT NULL,
  version integer DEFAULT 0 NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY(user_id, mode)
);
`;

let sqliteInstance: DatabaseSync | null = null;

function getSqlite(): DatabaseSync {
  if (sqliteInstance) return sqliteInstance;
  try {
    const dbPath = path.join(os.tmpdir(), "echo-d1-vercel.sqlite");
    sqliteInstance = new DatabaseSync(dbPath);
  } catch {
    sqliteInstance = new DatabaseSync(":memory:");
  }
  sqliteInstance.exec(SCHEMA_SQL);
  return sqliteInstance;
}

function createPreparedStatement(sql: string, boundArgs: unknown[] = []) {
  return {
    bind(...args: unknown[]) {
      return createPreparedStatement(sql, args);
    },
    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const db = getSqlite();
      const stmt = db.prepare(sql);
      const row = stmt.get(...(boundArgs as any[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (colName) return (row[colName] as T) ?? null;
      return row as T;
    },
    async all<T = Record<string, unknown>>() {
      const db = getSqlite();
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(boundArgs as any[])) as T[];
      return {
        results: rows,
        success: true as const,
        meta: {},
      };
    },
    async run() {
      const db = getSqlite();
      const stmt = db.prepare(sql);
      const result = stmt.run(...(boundArgs as any[]));
      return {
        results: [],
        success: true as const,
        meta: {
          changes: Number(result.changes ?? 0),
          last_row_id: Number(result.lastInsertRowid ?? 0),
        },
      };
    },
    async raw<T = unknown[]>() {
      const db = getSqlite();
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(boundArgs as any[])) as Record<string, unknown>[];
      return rows.map((r) => Object.values(r)) as unknown as T[];
    },
  };
}

const d1Adapter = {
  prepare(sql: string) {
    return createPreparedStatement(sql);
  },
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const out = [];
    for (const st of statements) {
      out.push(await st.run());
    }
    return out;
  },
  async exec(sql: string) {
    getSqlite().exec(sql);
    return { count: 1, duration: 0 };
  },
};

export const env = new Proxy(
  {
    DB: d1Adapter,
  },
  {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      if (typeof prop === "string") return process.env[prop];
      return undefined;
    },
  }
);
