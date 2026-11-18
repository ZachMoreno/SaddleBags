CREATE TABLE `audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`bag` text NOT NULL,
	`version` text NOT NULL,
	`pass_rate` real NOT NULL,
	`report` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_runs_id_unique` ON `eval_runs` (`id`);--> statement-breakpoint
CREATE TABLE `installs` (
	`bag` text NOT NULL,
	`version` text NOT NULL,
	`channel` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`bag`, `version`)
);
--> statement-breakpoint
CREATE TABLE `memory` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_scope_key` ON `memory` (`scope`,`scope_id`,`key`);--> statement-breakpoint
CREATE TABLE `memory_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `traces` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`operation` text NOT NULL,
	`bag` text NOT NULL,
	`bag_version` text NOT NULL,
	`scope` text NOT NULL,
	`model` text NOT NULL,
	`fired` text NOT NULL,
	`attempts` text NOT NULL,
	`ok` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traces_id_unique` ON `traces` (`id`);