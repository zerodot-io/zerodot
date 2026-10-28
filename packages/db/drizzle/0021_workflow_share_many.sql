ALTER TABLE "workflow_share" DROP CONSTRAINT "workflow_share_workflow_unique";--> statement-breakpoint
ALTER TABLE "workflow_share" ADD COLUMN "label" text;--> statement-breakpoint
CREATE INDEX "workflow_share_workflow_idx" ON "workflow_share" USING btree ("organization_id","workflow_id","created_at");