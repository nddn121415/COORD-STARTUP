CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`name` text NOT NULL,
	`encryption_key` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`pair_expires_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`project_id` text,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_user_code_unique` ON `devices` (`user_code`);--> statement-breakpoint
CREATE INDEX `devices_user` ON `devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `intents` (
	`device_id` text NOT NULL,
	`project_id` text NOT NULL,
	`paths` text NOT NULL,
	`summary` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `project_id`)
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`email` text NOT NULL,
	`sender_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_by` text
);
--> statement-breakpoint
CREATE INDEX `invitations_email` ON `invitations` (`email`);--> statement-breakpoint
CREATE TABLE `limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `members_user` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sender_device_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_project` ON `messages` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`owner_device_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_project` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sender_device_id` text NOT NULL,
	`recipient_device_id` text NOT NULL,
	`envelope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`blob_ready` integer DEFAULT 0 NOT NULL,
	`acked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transfers_recipient` ON `transfers` (`recipient_device_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL
);
