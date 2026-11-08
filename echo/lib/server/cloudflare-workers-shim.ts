import fs from "node:fs";
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

let sqliteInstance: any = undefined;

function getSqlite(): any {
  if (sqliteInstance !== undefined) return sqliteInstance;
  try {
    const req = eval("require");
    const { DatabaseSync } = req("node:sqlite");
    try {
      const dbPath = path.join(os.tmpdir(), "echo-d1-vercel.sqlite");
      sqliteInstance = new DatabaseSync(dbPath);
    } catch {
      sqliteInstance = new DatabaseSync(":memory:");
    }
    sqliteInstance.exec(SCHEMA_SQL);
    return sqliteInstance;
  } catch {
    sqliteInstance = null;
    return null;
  }
}

// Pure-JS JSON store fallback for Node 18/20 environments without node:sqlite
type StoreData = {
  echo_media_collections: Record<string, any>;
  echo_collections: Record<string, any>;
  echo_games: Record<string, any>;
  echo_settings: Record<string, any>;
  echo_progression: Record<string, any>;
  echo_profile_balances: Record<string, any>;
  echo_spotify_connections: Record<string, any>;
  echo_vinyl_tables: Record<string, any>;
  echo_vinyl_connections: Record<string, any>;
};

let memoryStore: StoreData | null = null;
const storePath = path.join(os.tmpdir(), "echo-d1-fallback.json");

function loadStore(): StoreData {
  if (memoryStore) return memoryStore;
  try {
    if (fs.existsSync(storePath)) {
      memoryStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return memoryStore!;
    }
  } catch {}
  memoryStore = {
    echo_media_collections: {},
    echo_collections: {},
    echo_games: {},
    echo_settings: {},
    echo_progression: {},
    echo_profile_balances: {},
    echo_spotify_connections: {},
    echo_vinyl_tables: {},
    echo_vinyl_connections: {},
  };
  return memoryStore;
}

function saveStore() {
  if (!memoryStore) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(memoryStore));
  } catch {}
}

function fallbackExec(sql: string, args: any[]): { rows: any[]; changes: number } {
  const s = sql.replace(/\s+/g, " ").trim();
  const store = loadStore();

  // echo_media_collections
  if (/FROM echo_media_collections WHERE id\s*=\s*\?/i.test(s)) {
    const row = store.echo_media_collections[String(args[0])];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }
  if (/FROM echo_media_collections WHERE id LIKE \?/i.test(s)) {
    const prefix = String(args[0]).replace(/%$/, "");
    const rows = Object.values(store.echo_media_collections)
      .filter((r: any) => String(r.id).startsWith(prefix))
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    return { rows, changes: 0 };
  }
  if (/FROM echo_media_collections WHERE id >= \? AND id < \?/i.test(s) || /FROM echo_media_collections WHERE id > \? AND id < \?/i.test(s)) {
    const [low, high, limit] = args;
    const rows = Object.values(store.echo_media_collections)
      .filter((r: any) => r.id >= low && r.id < high)
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, Number(limit) || 32);
    return { rows, changes: 0 };
  }
  if (/INSERT INTO echo_media_collections/i.test(s)) {
    const [id, track_data, updated_at] = args;
    store.echo_media_collections[String(id)] = { id, track_data, updated_at };
    saveStore();
    return { rows: [], changes: 1 };
  }

  // echo_collections
  if (/FROM echo_collections WHERE id\s*=\s*\? AND user_id\s*=\s*\?/i.test(s)) {
    const row = store.echo_collections[String(args[0])];
    return { rows: row && row.user_id === args[1] ? [{ ...row }] : [], changes: 0 };
  }
  if (/FROM echo_collections WHERE user_id\s*=\s*\?/i.test(s)) {
    const rows = Object.values(store.echo_collections)
      .filter((r: any) => r.user_id === args[0])
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, 30);
    return { rows, changes: 0 };
  }
  if (/INSERT INTO echo_collections/i.test(s)) {
    const [id, user_id, title, subtitle, track_ids, track_data, created_at, recipe] = args;
    if (!store.echo_collections[String(id)]) {
      store.echo_collections[String(id)] = { id, user_id, title, subtitle, track_ids, track_data, created_at, recipe: recipe ?? null };
      saveStore();
      return { rows: [], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }
  if (/UPDATE echo_collections SET title=\?,subtitle=\?,track_ids=\?,track_data=\?,recipe=\? WHERE id=\? AND user_id=\?/i.test(s)) {
    const [title, subtitle, track_ids, track_data, recipe, id, user_id] = args;
    const row = store.echo_collections[String(id)];
    if (row && row.user_id === user_id) {
      Object.assign(row, { title, subtitle, track_ids, track_data, recipe });
      saveStore();
      return { rows: [{ ...row }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }
  if (/UPDATE echo_collections SET track_ids = \?, track_data = \?, subtitle = \? WHERE id = \? AND user_id = \?/i.test(s)) {
    const [track_ids, track_data, subtitle, id, user_id] = args;
    const row = store.echo_collections[String(id)];
    if (row && row.user_id === user_id) {
      Object.assign(row, { track_ids, track_data, subtitle });
      saveStore();
      return { rows: [{ ...row }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }
  if (/DELETE FROM echo_collections WHERE id\s*=\s*\? AND user_id\s*=\s*\?/i.test(s)) {
    const [id, user_id] = args;
    const row = store.echo_collections[String(id)];
    if (row && row.user_id === user_id) {
      delete store.echo_collections[String(id)];
      saveStore();
      return { rows: [], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }

  // echo_games
  if (/FROM echo_games WHERE id\s*=\s*\? AND user_id\s*=\s*\?/i.test(s)) {
    const row = store.echo_games[String(args[0])];
    return { rows: row && row.user_id === args[1] ? [{ ...row }] : [], changes: 0 };
  }
  if (/FROM echo_games WHERE user_id\s*=\s*\? ORDER BY updated_at DESC/i.test(s)) {
    const rows = Object.values(store.echo_games)
      .filter((r: any) => r.user_id === args[0])
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 20);
    return { rows, changes: 0 };
  }
  if (/INSERT INTO echo_games/i.test(s)) {
    const [id, user_id, collection_id, collection_title, state, total, created_at, updated_at] = args;
    if (!store.echo_games[String(id)]) {
      store.echo_games[String(id)] = {
        id, user_id, collection_id, collection_title, state,
        version: 0, finished: 0, score_tenths: 0, correct: 0, total, xp: 0,
        created_at, updated_at,
      };
      saveStore();
      return { rows: [{ ...store.echo_games[String(id)] }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }
  if (/UPDATE echo_games SET state = \?, version = version \+ 1/i.test(s)) {
    const [state, finished, score_tenths, correct, xp, updated_at, id, user_id, version] = args;
    const row = store.echo_games[String(id)];
    if (row && row.user_id === user_id && row.version === version) {
      Object.assign(row, { state, finished, score_tenths, correct, xp, updated_at, version: row.version + 1 });
      saveStore();
      return { rows: [{ ...row }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }

  // wallet / profile aggregates
  if (/AS xp/i.test(s) && /echo_profile_balances/i.test(s)) {
    const userId = String(args[0]);
    const totalXp = Object.values(store.echo_games)
      .filter((g: any) => g.user_id === userId && g.finished === 1)
      .reduce((acc: number, g: any) => acc + (Number(g.xp) || 0), 0);
    const offset = store.echo_profile_balances[userId]?.offset_tenths ?? 0;
    const spent = store.echo_progression[userId]?.spent_tenths ?? 0;
    const xp = Math.max(0, Math.round(totalXp * 10) - offset - spent) / 10;
    return { rows: [{ xp }], changes: 0 };
  }
  if (/COUNT\(\*\) AS games/i.test(s) || /SUM\(correct\)/i.test(s)) {
    const userId = String(args[0]);
    const finishedGames = Object.values(store.echo_games).filter((g: any) => g.user_id === userId && g.finished === 1);
    const games = finishedGames.length;
    const correct = finishedGames.reduce((a: number, g: any) => a + (Number(g.correct) || 0), 0);
    const total = finishedGames.reduce((a: number, g: any) => a + (Number(g.total) || 0), 0);
    const xp = finishedGames.reduce((a: number, g: any) => a + (Number(g.xp) || 0), 0);
    return { rows: [{ games, correct, total, xp }], changes: 0 };
  }

  // echo_progression
  if (/FROM echo_progression WHERE user_id\s*=\s*\?/i.test(s)) {
    const row = store.echo_progression[String(args[0])];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }
  if (/INSERT INTO echo_progression/i.test(s) || /UPDATE echo_progression/i.test(s)) {
    const userId = String(args[0]);
    const current = store.echo_progression[userId] || { user_id: userId, spent_tenths: 0, unlocks: "{}", practice: 0 };
    if (/practice/i.test(s) && args.length >= 2) {
      current.practice = Number(args[args.length - 2] ?? args[1] ?? 0);
    }
    if (/unlocks/i.test(s) && args.length >= 3) {
      current.spent_tenths = Number(args[1] ?? current.spent_tenths);
      current.unlocks = String(args[2] ?? current.unlocks);
    }
    store.echo_progression[userId] = current;
    saveStore();
    return { rows: [{ ...current }], changes: 1 };
  }

  // echo_profile_balances
  if (/FROM echo_profile_balances WHERE user_id\s*=\s*\?/i.test(s)) {
    const row = store.echo_profile_balances[String(args[0])];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }

  // echo_settings
  if (/FROM echo_settings WHERE user_id\s*=\s*\?/i.test(s)) {
    const row = store.echo_settings[String(args[0])];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }
  if (/INSERT INTO echo_settings/i.test(s)) {
    const [user_id, encrypted_settings, updated_at] = args;
    if (!store.echo_settings[String(user_id)]) {
      store.echo_settings[String(user_id)] = { user_id, encrypted_settings, version: 0, updated_at };
      saveStore();
      return { rows: [{ user_id }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }
  if (/UPDATE echo_settings SET encrypted_settings/i.test(s)) {
    const [encrypted_settings, updated_at, user_id, version] = args;
    const row = store.echo_settings[String(user_id)];
    if (row && row.version === version) {
      Object.assign(row, { encrypted_settings, updated_at, version: row.version + 1 });
      saveStore();
      return { rows: [{ user_id }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }

  // echo_vinyl_tables
  if (/FROM echo_vinyl_tables WHERE user_id\s*=\s*\? AND mode\s*=\s*\?/i.test(s)) {
    const key = `${args[0]}:${args[1]}`;
    const row = store.echo_vinyl_tables[key];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }
  if (/INSERT INTO echo_vinyl_tables/i.test(s)) {
    const [user_id, mode, tables_json, updated_at] = args;
    const key = `${user_id}:${mode}`;
    if (!store.echo_vinyl_tables[key]) {
      store.echo_vinyl_tables[key] = { user_id, mode, tables_json, version: 1, updated_at };
      saveStore();
      return { rows: [{ version: 1 }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }
  if (/UPDATE echo_vinyl_tables SET tables_json/i.test(s)) {
    const [tables_json, updated_at, user_id, mode, version] = args;
    const key = `${user_id}:${mode}`;
    const row = store.echo_vinyl_tables[key];
    if (row && row.version === version) {
      Object.assign(row, { tables_json, updated_at, version: row.version + 1 });
      saveStore();
      return { rows: [{ version: row.version }], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }

  // echo_vinyl_connections
  if (/FROM echo_vinyl_connections WHERE user_id\s*=\s*\? AND provider\s*=\s*\?/i.test(s)) {
    const key = `${args[0]}:${args[1]}`;
    const row = store.echo_vinyl_connections[key];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }
  if (/INSERT INTO echo_vinyl_connections/i.test(s)) {
    const [user_id, provider, encrypted_connection, updated_at] = args;
    const key = `${user_id}:${provider}`;
    store.echo_vinyl_connections[key] = { user_id, provider, encrypted_connection, updated_at };
    saveStore();
    return { rows: [], changes: 1 };
  }
  if (/DELETE FROM echo_vinyl_connections/i.test(s)) {
    const key = `${args[0]}:${args[1]}`;
    delete store.echo_vinyl_connections[key];
    saveStore();
    return { rows: [], changes: 1 };
  }

  // echo_spotify_connections
  if (/FROM echo_spotify_connections WHERE user_id\s*=\s*\?/i.test(s)) {
    const row = store.echo_spotify_connections[String(args[0])];
    return { rows: row ? [{ ...row }] : [], changes: 0 };
  }

  return { rows: [], changes: 0 };
}

function createPreparedStatement(sql: string, boundArgs: unknown[] = []) {
  return {
    bind(...args: unknown[]) {
      return createPreparedStatement(sql, args);
    },
    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const db = getSqlite();
      if (db) {
        const stmt = db.prepare(sql);
        const row = stmt.get(...(boundArgs as any[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      }
      const { rows } = fallbackExec(sql, boundArgs as any[]);
      const row = rows[0];
      if (!row) return null;
      if (colName) return (row[colName] as T) ?? null;
      return row as T;
    },
    async all<T = Record<string, unknown>>() {
      const db = getSqlite();
      if (db) {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...(boundArgs as any[])) as T[];
        return { results: rows, success: true as const, meta: {} };
      }
      const { rows } = fallbackExec(sql, boundArgs as any[]);
      return { results: rows as T[], success: true as const, meta: {} };
    },
    async run() {
      const db = getSqlite();
      if (db) {
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
      }
      const { changes } = fallbackExec(sql, boundArgs as any[]);
      return { results: [], success: true as const, meta: { changes, last_row_id: 0 } };
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
