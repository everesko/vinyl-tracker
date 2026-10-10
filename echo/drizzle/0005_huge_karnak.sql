CREATE TABLE `echo_vinyl_connections` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_connection` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `echo_vinyl_tables` (
	`user_id` text NOT NULL,
	`mode` text NOT NULL,
	`tables_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `mode`)
);
