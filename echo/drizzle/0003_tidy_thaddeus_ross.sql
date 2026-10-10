CREATE TABLE `echo_progression` (
	`user_id` text PRIMARY KEY NOT NULL,
	`spent_tenths` integer DEFAULT 0 NOT NULL,
	`unlocks` text DEFAULT '{}' NOT NULL,
	`practice` integer DEFAULT 0 NOT NULL
);
