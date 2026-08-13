CREATE TABLE "alembic_version" (
	"version_num" varchar(32) PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"goodreads_book_id" varchar,
	"title" varchar NOT NULL,
	"author" varchar,
	"additional_authors" varchar,
	"isbn13" varchar,
	"exclusive_shelf" varchar,
	"goodreads_rating" integer NOT NULL,
	"app_rating" integer,
	"app_review" text,
	"feedback_updated_at" timestamp,
	"date_read" date,
	"date_added" date,
	"page_count" integer,
	"year_published" integer,
	"source" varchar NOT NULL,
	"exclude_from_profile" boolean DEFAULT false NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uq_book_user_goodreads" UNIQUE("user_id","goodreads_book_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_cache" (
	"cache_key" varchar PRIMARY KEY NOT NULL,
	"source" varchar NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "enrich_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" varchar NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"status" varchar NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"error" text,
	"lease_expires_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"run_limit" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"resolved_source" varchar,
	"resolved_id" varchar,
	"subjects" json,
	"series" varchar,
	"series_position" varchar,
	"description" text,
	"cover_url" varchar,
	"resolution_confidence" double precision NOT NULL,
	"confidence_label" varchar,
	"match_method" varchar,
	"raw_response" json,
	"resolved_at" timestamp DEFAULT now() NOT NULL,
	"language" varchar
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"category" varchar NOT NULL,
	"body" text NOT NULL,
	"trigger" varchar,
	"run_id" varchar,
	"page" varchar,
	"app_version" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_prompt_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"trigger" varchar NOT NULL,
	"run_id" varchar DEFAULT '' NOT NULL,
	"status" varchar NOT NULL,
	"snooze_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_feedback_prompt_state" UNIQUE("user_id","trigger","run_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"invited_by" varchar NOT NULL,
	"supabase_user_id" varchar,
	"status" varchar NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"accepted_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "profile_meta" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"last_profiled_at" timestamp,
	"last_profile_kind" varchar,
	"rec_feedback_updated_at" timestamp,
	"enrichment_corrected_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"bucket_key" varchar NOT NULL,
	"window_start" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_pkey" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
CREATE TABLE "reader_archetypes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"code" varchar NOT NULL,
	"archetype_name" varchar NOT NULL,
	"archetype_tagline" text NOT NULL,
	"axis_lens" double precision NOT NULL,
	"axis_engine" double precision NOT NULL,
	"axis_range" double precision NOT NULL,
	"axis_resonance" double precision NOT NULL,
	"lens_rationale" text,
	"engine_rationale" text,
	"range_rationale" text,
	"resonance_rationale" text,
	"derived_at" timestamp NOT NULL,
	CONSTRAINT "uq_reader_archetype_user" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"run_id" varchar NOT NULL,
	"rank" integer NOT NULL,
	"title" varchar NOT NULL,
	"author" varchar,
	"year" integer,
	"isbn13" varchar,
	"cover_url" varchar,
	"subjects" json,
	"catalog_source" varchar,
	"catalog_id" varchar,
	"retrieval_pool" varchar,
	"seed_reason" varchar,
	"score" double precision NOT NULL,
	"rationale" text,
	"grounded_trait_ids" json,
	"grounded_book_ids" json,
	"status" varchar NOT NULL,
	"user_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"description" text,
	"reject_reasons" json
);
--> statement-breakpoint
CREATE TABLE "taste_signal" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"direction" varchar NOT NULL,
	"target_kind" varchar NOT NULL,
	"target_book_id" integer,
	"snapshot" json,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taste_traits" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"claim" text NOT NULL,
	"polarity" varchar NOT NULL,
	"exhibits" json,
	"contrasts" json,
	"inference_confidence" double precision NOT NULL,
	"status" varchar NOT NULL,
	"user_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"user_weight" double precision DEFAULT '1' NOT NULL,
	"verdict_updated_at" timestamp,
	"reveal_line" text
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"model" varchar NOT NULL,
	"operation" varchar NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer NOT NULL,
	"cache_read_input_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_directive" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"nl_text" text,
	"constraints" json,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar DEFAULT 'local' NOT NULL,
	"anthropic_api_key_encrypted" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp,
	"display_name" varchar
);
--> statement-breakpoint
ALTER TABLE "enrichment" ADD CONSTRAINT "enrichment_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_books_exclusive_shelf" ON "books" USING btree ("exclusive_shelf" text_ops);--> statement-breakpoint
CREATE INDEX "ix_books_goodreads_book_id" ON "books" USING btree ("goodreads_book_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_books_isbn13" ON "books" USING btree ("isbn13" text_ops);--> statement-breakpoint
CREATE INDEX "ix_books_user_id" ON "books" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_enrich_jobs_job_id" ON "enrich_jobs" USING btree ("job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_enrich_jobs_user_id" ON "enrich_jobs" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrich_jobs_active_user" ON "enrich_jobs" USING btree ("user_id") WHERE "enrich_jobs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "ix_enrichment_book_id" ON "enrichment" USING btree ("book_id" int4_ops);--> statement-breakpoint
CREATE INDEX "ix_feedback_user_id" ON "feedback" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_invites_email" ON "invites" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "ix_invites_supabase_user_id" ON "invites" USING btree ("supabase_user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_profile_meta_user_id" ON "profile_meta" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_recommendations_run_id" ON "recommendations" USING btree ("run_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_recommendations_user_id" ON "recommendations" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_taste_signal_user_id" ON "taste_signal" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_taste_traits_user_id" ON "taste_traits" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_usage_events_created_at" ON "usage_events" USING btree ("created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "ix_usage_events_user_id" ON "usage_events" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_user_directive_user_id" ON "user_directive" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_user_settings_user_id" ON "user_settings" USING btree ("user_id" text_ops);