-- Bags were renamed to Plugins. Rename the columns in place so existing databases keep their data.
ALTER TABLE `traces` RENAME COLUMN `bag` TO `plugin`;--> statement-breakpoint
ALTER TABLE `traces` RENAME COLUMN `bag_version` TO `plugin_version`;--> statement-breakpoint
ALTER TABLE `installs` RENAME COLUMN `bag` TO `plugin`;--> statement-breakpoint
ALTER TABLE `eval_runs` RENAME COLUMN `bag` TO `plugin`;--> statement-breakpoint
ALTER TABLE `mcp_connections` RENAME COLUMN `bag` TO `plugin`;--> statement-breakpoint
ALTER TABLE `mcp_pins` RENAME COLUMN `bag` TO `plugin`;
