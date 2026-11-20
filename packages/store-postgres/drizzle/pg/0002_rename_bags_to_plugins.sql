-- Bags were renamed to Plugins. Rename the columns (and the constraints named after them) in place.
ALTER TABLE "traces" RENAME COLUMN "bag" TO "plugin";--> statement-breakpoint
ALTER TABLE "traces" RENAME COLUMN "bag_version" TO "plugin_version";--> statement-breakpoint
ALTER TABLE "installs" RENAME COLUMN "bag" TO "plugin";--> statement-breakpoint
ALTER TABLE "installs" RENAME CONSTRAINT "installs_bag_version_pk" TO "installs_plugin_version_pk";--> statement-breakpoint
ALTER TABLE "eval_runs" RENAME COLUMN "bag" TO "plugin";--> statement-breakpoint
ALTER TABLE "mcp_connections" RENAME COLUMN "bag" TO "plugin";--> statement-breakpoint
ALTER TABLE "mcp_pins" RENAME COLUMN "bag" TO "plugin";--> statement-breakpoint
ALTER TABLE "mcp_pins" RENAME CONSTRAINT "mcp_pins_bag_version_server_pk" TO "mcp_pins_plugin_version_server_pk";
