import { integer, real, text, sqliteTable, index, primaryKey } from "drizzle-orm/sqlite-core";

export const games = sqliteTable("echo_games", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  collectionId: text("collection_id").notNull(),
  collectionTitle: text("collection_title").notNull(),
  state: text("state").notNull(),
  version: integer("version").notNull().default(0),
  finished: integer("finished").notNull().default(0),
  score: integer("score_tenths").notNull().default(0),
  correct: integer("correct").notNull().default(0),
  total: integer("total").notNull(),
  xp: real("xp").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("echo_games_user_updated").on(table.userId, table.updatedAt)]);

export const spotifyConnections = sqliteTable("echo_spotify_connections", {
  userId: text("user_id").primaryKey(),
  encryptedTokens: text("encrypted_tokens").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const customCollections = sqliteTable("echo_collections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull(),
  trackIds: text("track_ids").notNull(),
  trackData: text("track_data"),
  recipe: text('recipe'),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("echo_collections_user_created").on(table.userId, table.createdAt)]);

export const userSettings = sqliteTable("echo_settings", {
  userId: text("user_id").primaryKey(),
  encryptedSettings: text("encrypted_settings").notNull(),
  version: integer("version").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const mediaCollections = sqliteTable("echo_media_collections", {
  id: text("id").primaryKey(),
  trackData: text("track_data").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Clearing a wallet preserves the original game results and their settlements.
export const profileBalances = sqliteTable("echo_profile_balances", {
  userId: text("user_id").primaryKey(),
  offsetTenths: integer("offset_tenths").notNull().default(0),
  resetAt: integer("reset_at").notNull(),
});

export const progression = sqliteTable('echo_progression', {
  userId:text('user_id').primaryKey(),
  spentTenths:integer('spent_tenths').notNull().default(0),
  unlocks:text('unlocks').notNull().default('{}'),
  practice:integer('practice').notNull().default(0),
});

// The imported tracker has three independent sets of tables. Every read and write
// is scoped to the authenticated owner, rather than the original shared JSON files.
export const vinylTables = sqliteTable('echo_vinyl_tables', {
  userId: text('user_id').notNull(),
  mode: text('mode').notNull(),
  tables: text('tables_json').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.mode] })]);

export const vinylConnections = sqliteTable('echo_vinyl_connections', {
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  encryptedConnection: text('encrypted_connection').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.provider] })]);
