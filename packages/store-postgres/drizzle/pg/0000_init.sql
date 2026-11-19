CREATE TABLE "audit" (
	"seq" serial PRIMARY KEY NOT NULL,
	"at" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"seq" serial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"bag" text NOT NULL,
	"version" text NOT NULL,
	"pass_rate" double precision NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "eval_runs_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "installs" (
	"bag" text NOT NULL,
	"version" text NOT NULL,
	"channel" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "installs_bag_version_pk" PRIMARY KEY("bag","version")
);
--> statement-breakpoint
CREATE TABLE "memory" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"seq" serial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"operation" text NOT NULL,
	"bag" text NOT NULL,
	"bag_version" text NOT NULL,
	"scope" text NOT NULL,
	"model" text NOT NULL,
	"fired" jsonb NOT NULL,
	"attempts" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "traces_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scope_key" ON "memory" USING btree ("scope","scope_id","key");