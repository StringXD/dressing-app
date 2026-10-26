DROP INDEX "garments_session_source_url_uq";--> statement-breakpoint
ALTER TABLE "garments" DROP COLUMN "source_url";--> statement-breakpoint
ALTER TABLE "garments" DROP COLUMN "platform";--> statement-breakpoint
ALTER TABLE "garments" DROP COLUMN "resolved_by";