CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"org_id" text NOT NULL,
	"group_id" text,
	"user_id" text,
	"secret_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"bag" text NOT NULL,
	"server" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"credential" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_pins" (
	"bag" text NOT NULL,
	"version" text NOT NULL,
	"server" text NOT NULL,
	"tools" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mcp_pins_bag_version_server_pk" PRIMARY KEY("bag","version","server")
);
--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "caller" text;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "notes" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_target" ON "mcp_connections" USING btree ("bag","server","scope","scope_id");