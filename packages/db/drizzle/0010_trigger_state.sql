CREATE TABLE "trigger_state" (
	"trigger_id" uuid PRIMARY KEY NOT NULL,
	"cursor" jsonb,
	"seen_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_hash" text,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trigger_state" ADD CONSTRAINT "trigger_state_trigger_id_trigger_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger"("id") ON DELETE cascade ON UPDATE no action;