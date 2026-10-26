CREATE TABLE "assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"generation_id" text,
	"asset_id" text,
	"model_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assessments_asset_target_uniq" ON "assessments" USING btree ("kind","asset_id") WHERE "assessments"."asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "assessments_generation_target_uniq" ON "assessments" USING btree ("kind","generation_id") WHERE "assessments"."generation_id" is not null;--> statement-breakpoint
CREATE INDEX "assessments_session_kind_idx" ON "assessments" USING btree ("session_id","kind");