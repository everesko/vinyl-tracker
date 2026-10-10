CREATE TABLE `echo_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text NOT NULL,
	`track_ids` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `echo_collections_user_created` ON `echo_collections` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `echo_games` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`collection_title` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`finished` integer DEFAULT 0 NOT NULL,
	`score_tenths` integer DEFAULT 0 NOT NULL,
	`correct` integer DEFAULT 0 NOT NULL,
	`total` integer NOT NULL,
	`xp` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `echo_games_user_updated` ON `echo_games` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `echo_spotify_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`encrypted_tokens` text NOT NULL,
	`updated_at` integer NOT NULL
);
