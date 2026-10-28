CREATE TABLE "project_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"run_retention_days" integer
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "test_target" jsonb;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;