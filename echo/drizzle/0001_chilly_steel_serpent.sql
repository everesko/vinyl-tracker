CREATE TABLE `echo_media_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`track_data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `echo_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`encrypted_settings` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `echo_collections` ADD `track_data` text;