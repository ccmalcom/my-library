ALTER TABLE "books" ALTER COLUMN "goodreads_rating" TYPE numeric(2,1) USING "goodreads_rating"::numeric(2,1);--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "app_rating" TYPE numeric(2,1) USING "app_rating"::numeric(2,1);--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "ck_books_app_rating_half_step" CHECK ("app_rating" IS NULL OR ("app_rating" >= 0.5 AND "app_rating" <= 5.0 AND ("app_rating" * 2) % 1 = 0));--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "ck_books_goodreads_rating_half_step" CHECK ("goodreads_rating" = 0 OR ("goodreads_rating" >= 0.5 AND "goodreads_rating" <= 5.0 AND ("goodreads_rating" * 2) % 1 = 0));
