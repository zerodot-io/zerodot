CREATE TABLE "error_stats" (
	"organization_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"sample_message" text NOT NULL,
	"last_run_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "error_stats_organization_id_workflow_id_fingerprint_bucket_start_mode_pk" PRIMARY KEY("organization_id","workflow_id","fingerprint","bucket_start","mode")
);
--> statement-breakpoint
CREATE TABLE "node_stats" (
	"organization_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_type" text NOT NULL,
	"node_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"duration_sum_ms" bigint DEFAULT 0 NOT NULL,
	"duration_buckets" integer[] NOT NULL,
	CONSTRAINT "node_stats_organization_id_workflow_id_node_type_node_id_bucket_start_mode_pk" PRIMARY KEY("organization_id","workflow_id","node_type","node_id","bucket_start","mode")
);
--> statement-breakpoint
CREATE TABLE "run_stats" (
	"organization_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"trigger_type" text NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"duration_sum_ms" bigint DEFAULT 0 NOT NULL,
	"duration_buckets" integer[] NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_stats_organization_id_workflow_id_bucket_start_mode_trigger_type_pk" PRIMARY KEY("organization_id","workflow_id","bucket_start","mode","trigger_type")
);
--> statement-breakpoint
ALTER TABLE "error_stats" ADD CONSTRAINT "error_stats_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_stats" ADD CONSTRAINT "error_stats_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_stats" ADD CONSTRAINT "node_stats_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_stats" ADD CONSTRAINT "node_stats_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_stats" ADD CONSTRAINT "run_stats_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_stats" ADD CONSTRAINT "run_stats_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_stats_org_bucket_idx" ON "error_stats" USING btree ("organization_id","bucket_start");--> statement-breakpoint
CREATE INDEX "node_stats_org_bucket_idx" ON "node_stats" USING btree ("organization_id","bucket_start");--> statement-breakpoint
CREATE INDEX "run_stats_org_bucket_idx" ON "run_stats" USING btree ("organization_id","bucket_start");