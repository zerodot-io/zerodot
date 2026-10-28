CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"idempotency_key" text,
	"version_id" uuid,
	"graph_snapshot" jsonb,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_node_id" text,
	"trigger_input" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_idempotency_unique" UNIQUE("workflow_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "run_node_result" (
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"port" text,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_node_result_run_id_node_id_attempt_pk" PRIMARY KEY("run_id","node_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "trigger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_version_id_workflow_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_node_result" ADD CONSTRAINT "run_node_result_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger" ADD CONSTRAINT "trigger_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger" ADD CONSTRAINT "trigger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_org_created_idx" ON "run" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "run_workflow_created_idx" ON "run" USING btree ("workflow_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_type_token_idx" ON "trigger" USING btree ("type",("config"->>'token'));--> statement-breakpoint
CREATE INDEX "trigger_workflow_idx" ON "trigger" USING btree ("workflow_id");