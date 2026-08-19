ALTER TABLE "feedback" ADD COLUMN "status" varchar DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "github_issue_number" integer;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "github_issue_url" varchar;