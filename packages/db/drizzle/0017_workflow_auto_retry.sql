ALTER TABLE "run" ADD COLUMN "auto_retry_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "auto_retry_max" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "auto_retry_backoff_ms" integer DEFAULT 0 NOT NULL;