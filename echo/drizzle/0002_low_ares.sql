CREATE TABLE `echo_profile_balances` (
	`user_id` text PRIMARY KEY NOT NULL,
	`offset_tenths` integer DEFAULT 0 NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
-- One-time reset requested by the sole existing player of this owner-private site.
-- Preserve history; never reset multiple accounts or future players on upgrades.
INSERT INTO echo_profile_balances (user_id, offset_tenths, reset_at)
SELECT user_id, CAST(ROUND(SUM(CASE WHEN finished = 1 THEN xp ELSE 0 END)*10) AS INTEGER), CAST(strftime('%s','now') AS INTEGER)*1000
FROM echo_games
WHERE (SELECT COUNT(DISTINCT user_id) FROM echo_games) = 1
GROUP BY user_id
ON CONFLICT(user_id) DO NOTHING;
