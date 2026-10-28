ALTER TABLE "workflow" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "save_success_data" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "save_failure_data" boolean DEFAULT true NOT NULL;