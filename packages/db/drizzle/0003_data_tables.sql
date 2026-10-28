CREATE TABLE "data_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_table_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "data_table_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "data_table_unique" (
	"table_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"row_id" uuid NOT NULL,
	CONSTRAINT "data_table_unique_table_id_key_value_pk" PRIMARY KEY("table_id","key","value")
);
--> statement-breakpoint
ALTER TABLE "data_table" ADD CONSTRAINT "data_table_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_table_row" ADD CONSTRAINT "data_table_row_table_id_data_table_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_table"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_table_row" ADD CONSTRAINT "data_table_row_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_table_unique" ADD CONSTRAINT "data_table_unique_table_id_data_table_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_table"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_table_unique" ADD CONSTRAINT "data_table_unique_row_id_data_table_row_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."data_table_row"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_table_org_idx" ON "data_table" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "data_table_row_page_idx" ON "data_table_row" USING btree ("table_id","created_at","id");--> statement-breakpoint
CREATE INDEX "data_table_row_data_idx" ON "data_table_row" USING gin ("data");--> statement-breakpoint
CREATE INDEX "data_table_unique_row_idx" ON "data_table_unique" USING btree ("row_id");