# Wave 4 read-only inventory

Scope interpreted from the migration markers as:

- Enrichment: `POST /enrich/start`, `GET /enrich/status/{job_id}`, and the synchronous compatibility endpoint `POST /enrich`.
- Ingest/import/export at inventory time: `POST /ingest` and `POST /ingest/upload` (both deleted in wave 4b), plus `POST /import/preview`, `POST /import`, and `GET /export`.
- Purges: `DELETE /library`, `DELETE /profile`, and `DELETE /account`.

All eleven routes require the shared `UserId` dependency. That dependency resolves the bearer token through `resolve_user_id`, returns `401` on failure, and stores the resolved user ID on `request.state` for per-user rate limiting ([mylibrary/api.py:223](/home/chase/Documents/Code/my-library/mylibrary/api.py:223), [mylibrary/api.py:242](/home/chase/Documents/Code/my-library/mylibrary/api.py:242)). None is anonymous.

## 1. FastAPI routes in Wave 4

| Method and path | Handler | Request model/input | Response contract | Auth / rate limit | Python calls |
|---|---|---|---|---|---|
| `POST /ingest` (deleted in wave 4b) | [mylibrary/api.py:435](/home/chase/Documents/Code/my-library/mylibrary/api.py:435) | JSON `IngestRequest`: optional `csv_path`; defaults to configured CSV path ([mylibrary/schemas.py:15](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:15)) | Unmodeled `dict`: `total_rows`, `inserted`, `updated`, `rated`, `skipped` ([mylibrary/ingest.py:19](/home/chase/Documents/Code/my-library/mylibrary/ingest.py:19)) | `UserId`; no limiter decorator | `get_settings()` and `ingest.ingest_csv()` ([mylibrary/api.py:436](/home/chase/Documents/Code/my-library/mylibrary/api.py:436)); then `importers.formats.parse_goodreads()` and `importers.core.import_rows()` ([mylibrary/ingest.py:31](/home/chase/Documents/Code/my-library/mylibrary/ingest.py:31)) |
| `POST /ingest/upload` (deleted in wave 4b) | [mylibrary/api.py:444](/home/chase/Documents/Code/my-library/mylibrary/api.py:444) | Multipart `file: UploadFile`; filename must end in `.csv` ([mylibrary/api.py:451](/home/chase/Documents/Code/my-library/mylibrary/api.py:451)) | Same unmodeled ingest summary | `UserId`; no limiter | `get_settings()`, filesystem temp-file/atomic replacement, then `ingest_csv()` ([mylibrary/api.py:454](/home/chase/Documents/Code/my-library/mylibrary/api.py:454), [mylibrary/api.py:458](/home/chase/Documents/Code/my-library/mylibrary/api.py:458), [mylibrary/api.py:469](/home/chase/Documents/Code/my-library/mylibrary/api.py:469)) |
| `POST /import/preview` | [mylibrary/api.py:491](/home/chase/Documents/Code/my-library/mylibrary/api.py:491) | Multipart `file: UploadFile`; `.csv`, UTF-8/UTF-8-BOM ([mylibrary/api.py:480](/home/chase/Documents/Code/my-library/mylibrary/api.py:480)) | `ImportPreviewOut`: `format`, `headers`, `sample_rows`, `suggested_mapping` ([mylibrary/schemas.py:480](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:480)) | `UserId`; no limiter | `_decode_upload()`, `csv_headers()`, `detect_format()`, `sample_rows()`, `suggest_mapping()` ([mylibrary/api.py:497](/home/chase/Documents/Code/my-library/mylibrary/api.py:497)) |
| `POST /import` | [mylibrary/api.py:507](/home/chase/Documents/Code/my-library/mylibrary/api.py:507) | Multipart `file`; form `format="auto"`; optional JSON-string `mapping` ([mylibrary/api.py:508](/home/chase/Documents/Code/my-library/mylibrary/api.py:508)) | `ImportSummaryOut`: `format`, `total_rows`, `skipped`, `inserted`, `updated`, `rated` ([mylibrary/schemas.py:489](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:489)) | `UserId`; no limiter | `_decode_upload()`, `json.loads()`, `importers.import_text()` ([mylibrary/api.py:519](/home/chase/Documents/Code/my-library/mylibrary/api.py:519), [mylibrary/api.py:535](/home/chase/Documents/Code/my-library/mylibrary/api.py:535)) |
| `GET /export` | [mylibrary/api.py:541](/home/chase/Documents/Code/my-library/mylibrary/api.py:541) | Query `format`, default `csv`; accepted values `csv` and `json` ([mylibrary/api.py:542](/home/chase/Documents/Code/my-library/mylibrary/api.py:542), [mylibrary/api.py:561](/home/chase/Documents/Code/my-library/mylibrary/api.py:561)) | Raw `Response`: CSV or formatted JSON with attachment `Content-Disposition` ([mylibrary/api.py:544](/home/chase/Documents/Code/my-library/mylibrary/api.py:544)) | `UserId`; no limiter | `exporters.export_csv()` or `exporters.export_json()` ([mylibrary/api.py:545](/home/chase/Documents/Code/my-library/mylibrary/api.py:545), [mylibrary/api.py:553](/home/chase/Documents/Code/my-library/mylibrary/api.py:553)) |
| `POST /enrich/start` | [mylibrary/api.py:566](/home/chase/Documents/Code/my-library/mylibrary/api.py:566) | JSON `EnrichStartRequest`: `force=false`, optional `limit` ([mylibrary/schemas.py:25](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:25)) | `EnrichJobOut` ([mylibrary/schemas.py:32](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:32)) | `UserId`; `@limiter.limit("5/minute")`, keyed by authenticated user ([mylibrary/api.py:567](/home/chase/Documents/Code/my-library/mylibrary/api.py:567), [mylibrary/api.py:141](/home/chase/Documents/Code/my-library/mylibrary/api.py:141)) | `worker.create_enrich_job()`; either `arq_pool.enqueue_job("enrich_books", …)` or FastAPI `background_tasks.add_task(run_enrich_job, …)`; finally loads `EnrichJob` ([mylibrary/api.py:580](/home/chase/Documents/Code/my-library/mylibrary/api.py:580), [mylibrary/api.py:582](/home/chase/Documents/Code/my-library/mylibrary/api.py:582), [mylibrary/api.py:595](/home/chase/Documents/Code/my-library/mylibrary/api.py:595), [mylibrary/api.py:603](/home/chase/Documents/Code/my-library/mylibrary/api.py:603)) |
| `GET /enrich/status/{job_id}` | [mylibrary/api.py:608](/home/chase/Documents/Code/my-library/mylibrary/api.py:608) | Path parameter `job_id: str` | `EnrichJobOut`; `404` if absent or owned by another user ([mylibrary/api.py:614](/home/chase/Documents/Code/my-library/mylibrary/api.py:614)) | `UserId`; no limiter | User-scoped `EnrichJob` query, then `worker.fail_if_stale()` ([mylibrary/api.py:615](/home/chase/Documents/Code/my-library/mylibrary/api.py:615), [mylibrary/api.py:622](/home/chase/Documents/Code/my-library/mylibrary/api.py:622)) |
| `POST /enrich` | [mylibrary/api.py:626](/home/chase/Documents/Code/my-library/mylibrary/api.py:626) | JSON `EnrichRequest`: `force=false`, optional `limit`, `include_unrated=false` ([mylibrary/schemas.py:19](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:19)) | Unmodeled enrichment summary `dict` | `UserId`; explicitly not rate-limited and not exposed in hosted UI ([mylibrary/api.py:628](/home/chase/Documents/Code/my-library/mylibrary/api.py:628)) | Direct blocking `enrich.enrich_library()` ([mylibrary/api.py:634](/home/chase/Documents/Code/my-library/mylibrary/api.py:634)) |
| `DELETE /library` | [mylibrary/api.py:807](/home/chase/Documents/Code/my-library/mylibrary/api.py:807) | No body | Unmodeled purge-count `dict` | `UserId`; no limiter | `purge.clear_library()` ([mylibrary/api.py:808](/home/chase/Documents/Code/my-library/mylibrary/api.py:808)) |
| `DELETE /profile` | [mylibrary/api.py:813](/home/chase/Documents/Code/my-library/mylibrary/api.py:813) | No body | Unmodeled purge-count `dict` | `UserId`; no limiter | `purge.clear_profile()` ([mylibrary/api.py:814](/home/chase/Documents/Code/my-library/mylibrary/api.py:814)) |
| `DELETE /account` | [mylibrary/api.py:819](/home/chase/Documents/Code/my-library/mylibrary/api.py:819) | No body | Unmodeled purge-count `dict` | `UserId`; no limiter | `purge.delete_account()` ([mylibrary/api.py:820](/home/chase/Documents/Code/my-library/mylibrary/api.py:820)) |

The `EnrichJobOut` wire fields are `job_id`, `status`, `progress`, `total`, nullable `error`, nullable `started_at`, and—continuing the model—nullable completion timestamps. Its lifecycle is documented as `pending → running → done | error` ([mylibrary/schemas.py:32](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:32)).

## 2. Python background-job mechanism

### Startup and execution modes

FastAPI startup:

1. Initializes the database.
2. Calls `recover_orphaned_jobs()`.
3. If `REDIS_URL` exists, creates an arq Redis pool and stores it at `app.state.arq_pool`; otherwise stores `None`.
4. Closes the pool during shutdown.

This is implemented in the lifespan handler ([mylibrary/api.py:151](/home/chase/Documents/Code/my-library/mylibrary/api.py:151)).

There are two execution modes sharing the same core runner:

- Default/no Redis: FastAPI `BackgroundTasks` invokes blocking `run_enrich_job()` in the web process ([mylibrary/api.py:592](/home/chase/Documents/Code/my-library/mylibrary/api.py:592)).
- Redis configured: the API enqueues arq function name `enrich_books`; an independently launched `mylibrary.worker.WorkerSettings` process consumes it ([mylibrary/api.py:583](/home/chase/Documents/Code/my-library/mylibrary/api.py:583), [mylibrary/worker.py:205](/home/chase/Documents/Code/my-library/mylibrary/worker.py:205)). The documented worker command is `python -m arq mylibrary.worker.WorkerSettings` ([mylibrary/worker.py:205](/home/chase/Documents/Code/my-library/mylibrary/worker.py:205)).

The arq wrapper uses `run_in_executor` because `enrich_library()` is synchronous ([mylibrary/worker.py:156](/home/chase/Documents/Code/my-library/mylibrary/worker.py:156)).

### Starting and tracking

`create_enrich_job()` generates a UUID and inserts an `EnrichJob` row with `status="pending"` ([mylibrary/worker.py:177](/home/chase/Documents/Code/my-library/mylibrary/worker.py:177), [mylibrary/worker.py:182](/home/chase/Documents/Code/my-library/mylibrary/worker.py:182)).

`run_enrich_job()` then:

- Loads the row by `job_id`; if it has already been deleted, returns without work.
- Sets `status="running"` and `started_at`.
- Passes an `on_progress` callback to `enrich_library()`.
- Flushes progress at start, finish, or every five books.
- On success sets `status="done"`, `finished_at`, final `progress`, and `total`.
- On failure sets `status="error"`, `finished_at`, and an error string truncated to 2,000 characters, then re-raises.

See [mylibrary/worker.py:94](/home/chase/Documents/Code/my-library/mylibrary/worker.py:94), [mylibrary/worker.py:107](/home/chase/Documents/Code/my-library/mylibrary/worker.py:107), [mylibrary/worker.py:117](/home/chase/Documents/Code/my-library/mylibrary/worker.py:117), and [mylibrary/worker.py:127](/home/chase/Documents/Code/my-library/mylibrary/worker.py:127).

The enrichment function is idempotent unless forced: it skips books already holding enrichment, uses cached catalog responses, resolves through Open Library and Google Books, and writes `Enrichment` rows ([mylibrary/enrich.py:8](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:8), [mylibrary/enrich.py:15](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:15), [mylibrary/enrich.py:151](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:151), [mylibrary/enrich.py:180](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:180)).

### Polling and frontend reporting

`GET /enrich/status/{job_id}` filters by both `job_id` and authenticated `user_id`; cross-user IDs are indistinguishable from nonexistent IDs and return `404` ([mylibrary/api.py:608](/home/chase/Documents/Code/my-library/mylibrary/api.py:608)).

The frontend API client starts and polls jobs through `api.enrichStart()` and `api.enrichStatus()` ([frontend/lib/api.ts:551](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:551)). `SetupWizard` polls every 2 seconds, displays `progress / total`, exits on `done`, and surfaces the job’s `error` on failure ([frontend/components/SetupWizard.tsx:525](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:525), [frontend/components/SetupWizard.tsx:541](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:541), [frontend/components/SetupWizard.tsx:560](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:560)).

### Recovery safeguards

In no-Redis mode, startup marks all lingering `pending` or `running` jobs as `error`, sets a standard interrupted message, and records `finished_at`. In Redis mode this is deliberately a no-op because a separate worker may still own the job ([mylibrary/worker.py:35](/home/chase/Documents/Code/my-library/mylibrary/worker.py:35)).

Polling also invokes `fail_if_stale()`. A `running` job older than 1,800 seconds is changed to `error`; pending, completed, and jobs without `started_at` are not changed ([mylibrary/worker.py:62](/home/chase/Documents/Code/my-library/mylibrary/worker.py:62), [mylibrary/worker.py:65](/home/chase/Documents/Code/my-library/mylibrary/worker.py:65)).

### Tables and columns

Primary tracking table: `enrich_jobs`.

| Column | Purpose |
|---|---|
| `id` | Integer primary key |
| `job_id` | Unique indexed client-visible UUID |
| `user_id` | Indexed owner |
| `status` | `pending`, `running`, `done`, or `error` |
| `progress` | Number processed |
| `total` | Total scheduled |
| `started_at` | Start timestamp |
| `finished_at` | Terminal timestamp |
| `error` | Failure/interruption text |
| `created_at` | Creation timestamp |

Python declaration: [mylibrary/db.py:250](/home/chase/Documents/Code/my-library/mylibrary/db.py:250). The table has already been introspected into the Node Drizzle schema, including indexes, but no Node job implementation uses it yet ([frontend/lib/server/schema.ts:153](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:153)).

Enrichment work reads `books` and creates/updates `enrichment`:

- `books`: ownership, source identifiers, title/author, ISBN, shelf, imported/app ratings and review, dates, page/year, and source ([mylibrary/db.py:58](/home/chase/Documents/Code/my-library/mylibrary/db.py:58)).
- `enrichment`: one row per `book_id`, with resolved source/ID, subjects, series, language, description, cover, confidence, match method, raw response, and timestamp ([mylibrary/db.py:121](/home/chase/Documents/Code/my-library/mylibrary/db.py:121)).

## 3. Ingest, import, and export paths

### Upload and decoding

The legacy `/ingest/upload` route, deleted in wave 4b, was Goodreads-specific and persisted the uploaded file at the configured CSV path. It streamed to a temporary file in the destination directory and used `os.replace()` for an atomic rename, avoiding a half-written canonical file ([mylibrary/api.py:444](/home/chase/Documents/Code/my-library/mylibrary/api.py:444), [mylibrary/api.py:458](/home/chase/Documents/Code/my-library/mylibrary/api.py:458)).

The general importer does not persist the upload. `_decode_upload()` reads it directly, rejects non-`.csv` names, and decodes `utf-8-sig`, which accepts ordinary UTF-8 and strips a BOM ([mylibrary/api.py:480](/home/chase/Documents/Code/my-library/mylibrary/api.py:480)).

### CSV parsing

All formats converge on the `ImportRow` dataclass:

`title`, `author`, `additional_authors`, `isbn13`, `shelf`, `rating`, `review`, `date_read`, `date_added`, `page_count`, `year_published`, and optional source-native `external_id` ([mylibrary/importers/core.py:105](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:105)).

Parsing uses `csv.DictReader(io.StringIO(text))` ([mylibrary/importers/formats.py:46](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:46)). Shared normalization includes:

- Goodreads Excel-escaped ISBN cleanup ([mylibrary/importers/core.py:22](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:22)).
- Integer parsing tolerant of float-formatted numbers ([mylibrary/importers/core.py:33](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:33)).
- Dates in `YYYY/MM/DD`, `YYYY-MM-DD`, or `MM/DD/YYYY` ([mylibrary/importers/core.py:45](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:45)).
- Half-up star rounding and clamping to `1..5`; blank, zero, and invalid values become unrated ([mylibrary/importers/core.py:59](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:59)).
- Cross-service shelf synonyms normalized to the application’s canonical shelves ([mylibrary/importers/core.py:79](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:79)).

Supported parsers:

- Goodreads: recognizes `Book Id` plus `Exclusive Shelf`; retains `Book Id` as `external_id`; deliberately does not seed Goodreads “My Review” ([mylibrary/importers/formats.py:77](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:77), [mylibrary/importers/formats.py:145](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:145)).
- StoryGraph: recognizes `Read Status` plus `Star Rating`, splits primary/additional authors, accepts only 13-digit ISBN values from `ISBN/UID`, and imports reviews ([mylibrary/importers/formats.py:109](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:109), [mylibrary/importers/formats.py:117](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:117)).
- Canonical backup CSV: recognized by lower-case `title`, `shelf`, and `rating`; parses all canonical columns ([mylibrary/importers/formats.py:152](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:152), [mylibrary/importers/formats.py:157](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:157)).
- Generic: requires a title mapping; supports mapped `title`, `author`, `isbn13`, `rating`, `review`, `shelf`, and `date_read` ([mylibrary/importers/formats.py:30](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:30), [mylibrary/importers/formats.py:207](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:207)).

Preview returns headers, the first five rows, detected format, and substring-based mapping suggestions without any writes or network calls ([mylibrary/importers/formats.py:51](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:51), [mylibrary/importers/formats.py:56](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:56), [mylibrary/importers/formats.py:184](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:184)).

`import_text()` performs detection/selection, calls the chosen parser, maps the parser to a source label, and invokes the shared upsert ([mylibrary/importers/formats.py:23](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:23), [mylibrary/importers/formats.py:245](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:245)).

### Import-once and never-clobber invariants

The authoritative invariant lives in `import_rows()`, not in individual format parsers ([mylibrary/importers/core.py:1](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:1)).

Deduplication precedence is:

1. If `external_id` is present, match only `(user_id, goodreads_book_id)`.
2. Otherwise match ISBN-13.
3. Otherwise match normalized title plus author surname.

See [mylibrary/importers/core.py:135](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:135) and [mylibrary/importers/core.py:146](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:146). Database uniqueness independently enforces `(user_id, goodreads_book_id)` ([mylibrary/db.py:103](/home/chase/Documents/Code/my-library/mylibrary/db.py:103)).

On re-import, only these import-owned fields are eligible for update:

- `author`
- `additional_authors`
- `isbn13`
- `exclusive_shelf`
- `date_read`
- `date_added`
- `page_count`
- `year_published`
- `goodreads_rating`

The explicit tuple excludes `app_rating`, `app_review`, `feedback_updated_at`, and other app-owned state ([mylibrary/importers/core.py:121](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:121)). Even those eligible fields are updated only when the incoming value is non-`None`, so sparse imports do not null existing data ([mylibrary/importers/core.py:213](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:213)).

For a new row:

- Imported rating is stored in `goodreads_rating`.
- `app_rating` remains unset.
- A non-Goodreads imported review seeds `app_review` only when a rating is also present.
- That review seeding happens only on initial insertion, never on an existing book.

See [mylibrary/importers/core.py:181](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:181) and [mylibrary/importers/core.py:197](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:197).

At read time, `Book.effective_rating` returns `app_rating` whenever it is set; otherwise it falls back to the imported `goodreads_rating` ([mylibrary/db.py:109](/home/chase/Documents/Code/my-library/mylibrary/db.py:109)). This is the other half of the “never clobber app rating” behavior.

### Export

CSV export:

- Uses the canonical field list, making it re-importable.
- Selects only the authenticated user’s books in ID order.
- Exports `effective_rating`, not merely the imported rating.
- Exports `app_review`.
- Emits empty strings for absent optional fields.

See [mylibrary/exporters.py:22](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:22) and [mylibrary/exporters.py:34](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:34).

JSON export contains:

- Version and UTC export timestamp.
- Books with both `goodreads_rating` and `app_rating`, `app_review`, computed `effective_rating`, favorite/exclusion state, dates, metadata, and source.
- Durable `taste_signal` rows with direction, target, snapshot, and timestamp.

See [mylibrary/exporters.py:53](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:53).

The frontend already has multipart client methods and corresponding TypeScript response types, but they currently target Python in auto mode ([frontend/lib/api.ts:211](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:211), [frontend/lib/api.ts:504](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:504), [frontend/lib/api.ts:520](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:520), [frontend/lib/api.ts:533](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:533)).

## 4. Purge behavior

All purge operations use one `session_scope()`, so each public operation is a single database transaction ([mylibrary/purge.py:93](/home/chase/Documents/Code/my-library/mylibrary/purge.py:93), [mylibrary/purge.py:101](/home/chase/Documents/Code/my-library/mylibrary/purge.py:101), [mylibrary/purge.py:117](/home/chase/Documents/Code/my-library/mylibrary/purge.py:117)).

Enrichments must be explicitly deleted before books because bulk ORM deletes do not trigger relationship cascades and `enrichment.book_id` is a foreign key ([mylibrary/purge.py:21](/home/chase/Documents/Code/my-library/mylibrary/purge.py:21), [mylibrary/purge.py:77](/home/chase/Documents/Code/my-library/mylibrary/purge.py:77)).

### `DELETE /profile`

Removes user-scoped rows from:

- `taste_traits`
- `recommendations`
- `profile_meta`
- `reader_archetypes`

The helper and ordering are at [mylibrary/purge.py:48](/home/chase/Documents/Code/my-library/mylibrary/purge.py:48).

It keeps:

- `books`
- `enrichment`
- `user_settings`
- `taste_signal`
- `enrich_jobs`
- `usage_events`
- `user_directive`
- General feedback/prompt-state data
- Supabase auth user

Returned fields are `traits_removed`, `recommendations_removed`, and `profile_reset: true` ([mylibrary/purge.py:93](/home/chase/Documents/Code/my-library/mylibrary/purge.py:93)). Durable-row expectations are explicitly tested at [tests/test_purge.py:75](/home/chase/Documents/Code/my-library/tests/test_purge.py:75).

### `DELETE /library`

Performs the complete `/profile` purge, then removes:

- Every `enrichment` row belonging to the user’s book IDs.
- Every user-owned `books` row.

See [mylibrary/purge.py:77](/home/chase/Documents/Code/my-library/mylibrary/purge.py:77) and [mylibrary/purge.py:101](/home/chase/Documents/Code/my-library/mylibrary/purge.py:101).

It keeps:

- `user_settings`, including the encrypted Anthropic key
- `taste_signal`
- `enrich_jobs`
- `usage_events`
- `user_directive`
- Feedback/prompt-state data
- Supabase auth user

Returned fields are `books_removed`, `traits_removed`, `recommendations_removed`, and `profile_reset: true` ([mylibrary/purge.py:107](/home/chase/Documents/Code/my-library/mylibrary/purge.py:107)). The durability contract is tested at [tests/test_purge.py:88](/home/chase/Documents/Code/my-library/tests/test_purge.py:88).

### `DELETE /account`

Performs the complete library and profile purge, then removes user-scoped rows from:

- `user_settings`
- `taste_signal`
- `enrich_jobs`
- `usage_events`
- `user_directive`

See [mylibrary/purge.py:117](/home/chase/Documents/Code/my-library/mylibrary/purge.py:117).

Returned fields are:

- `books_removed`
- `traits_removed`
- `recommendations_removed`
- `settings_removed`
- `signals_removed`
- `jobs_removed`
- `usage_events_removed`
- `directive_removed`
- `account_deleted: true`

The response is assembled at [mylibrary/purge.py:152](/home/chase/Documents/Code/my-library/mylibrary/purge.py:152).

Despite its docstring saying “no rows anywhere,” the implementation does **not** delete:

- Supabase authentication identity.
- `feedback` rows.
- `feedback_prompt_state` rows.
- `invites` rows.

That distinction follows directly from the imported model list and delete statements ([mylibrary/purge.py:31](/home/chase/Documents/Code/my-library/mylibrary/purge.py:31), [mylibrary/purge.py:117](/home/chase/Documents/Code/my-library/mylibrary/purge.py:117)). The module explicitly says account deletion is app-data-only and does not delete the Supabase user ([mylibrary/purge.py:17](/home/chase/Documents/Code/my-library/mylibrary/purge.py:17)).

All deletes are user-scoped; multi-tenant isolation is covered by [tests/test_purge.py:124](/home/chase/Documents/Code/my-library/tests/test_purge.py:124).

## 5. Existing Node pattern: `POST /discover`

### End-to-end file chain

1. UI page calls `api.discover(q)`:
   - [frontend/app/(main)/discover/page.tsx:25](/home/chase/Documents/Code/my-library/frontend/app/(main)/discover/page.tsx:25)

2. Typed frontend client:
   - `DiscoverBook`/`DiscoverResult` contracts: [frontend/lib/api.ts:93](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:93)
   - `api.discover()` sends `POST /discover`: [frontend/lib/api.ts:446](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:446)
   - Shared fetch helper chooses backend via `baseFor(path, "POST")`: [frontend/lib/api.ts:373](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:373)

3. Backend selection:
   - Exact method-aware Node rule: [frontend/lib/backend.ts:49](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:49)

4. Next.js route handler:
   - [frontend/app/api/discover/route.ts:1](/home/chase/Documents/Code/my-library/frontend/app/api/discover/route.ts:1)
   - Declares `maxDuration=300`, validates with Zod, applies the per-user `30/minute` limit, resolves the Anthropic key, constructs the client, invokes `runDiscover()`, and serializes JSON ([frontend/app/api/discover/route.ts:8](/home/chase/Documents/Code/my-library/frontend/app/api/discover/route.ts:8), [frontend/app/api/discover/route.ts:28](/home/chase/Documents/Code/my-library/frontend/app/api/discover/route.ts:28)).

5. Shared route wrapper:
   - `withApi()` handles authentication, admin checks, FastAPI-shaped errors, route parameters, logging, request IDs, and timing ([frontend/lib/server/http.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:1), [frontend/lib/server/http.ts:35](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:35)).

6. Database/client seam:
   - `getDb()` provides the shared Drizzle/Postgres connection and the test override seam ([frontend/lib/server/db.ts:18](/home/chase/Documents/Code/my-library/frontend/lib/server/db.ts:18), [frontend/lib/server/db.ts:23](/home/chase/Documents/Code/my-library/frontend/lib/server/db.ts:23)).

7. Discovery orchestrator:
   - [frontend/lib/server/recDiscoverRun.ts:48](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:48)
   - Builds the reader signal, interprets the request, retrieves catalog candidates, applies hard constraints, assembles/fills candidates, reranks, and serializes the response ([frontend/lib/server/recDiscoverRun.ts:65](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:65), [frontend/lib/server/recDiscoverRun.ts:92](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:92), [frontend/lib/server/recDiscoverRun.ts:113](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:113)).

8. Direct service dependencies:
   - Prompts and tool schemas: `recDiscoverPrompts.ts`, imported at [frontend/lib/server/recDiscoverRun.ts:25](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:25).
   - Candidate retrieval/assembly: `recAssemble.ts`, imported at [frontend/lib/server/recDiscoverRun.ts:16](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:16).
   - Constraint cleaning/filtering: `recFilters.ts`, imported at [frontend/lib/server/recDiscoverRun.ts:24](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:24).
   - Reader signal/exclusions: `recSignal.ts`, imported at [frontend/lib/server/recDiscoverRun.ts:34](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:34).
   - Claude invocation and usage tracking: `anthropic.ts` and `claude.ts`, imported at [frontend/lib/server/recDiscoverRun.ts:11](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:11).
   - Shared model constants: `recPrompts.ts`, imported at [frontend/lib/server/recDiscoverRun.ts:33](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:33).
   - Catalog access underneath assembly: `catalog.ts`/`catalogCache.ts`.
   - Shared error strings and serialization: `claudeErrors.ts`, `errors.ts`, and `serialize.ts`.

### Layering convention

The observed convention is:

```text
client API method
  → backend switcher
  → app/api/**/route.ts
  → withApi auth/error/log wrapper
  → domain orchestrator in lib/server/*
  → focused DB/catalog/Claude/filter/prompt helpers
  → Drizzle schema/shared Postgres
```

The route handler owns HTTP concerns: parsing, validation, auth wrapper, rate limiting, status/error mapping, and response serialization. Domain orchestration lives under `frontend/lib/server/`.

### Transaction placement

`POST /discover` opens **no domain transaction** because its recommendations are ephemeral and are not persisted; the orchestrator says this explicitly ([frontend/lib/server/recDiscoverRun.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/recDiscoverRun.ts:1)). Rate-limit and usage-tracking helpers may perform their own writes, but there is no transaction wrapping the discovery pipeline.

For routes with an atomic multi-write domain operation, the transaction belongs around the coherent mutation in the route or service layer—not around `withApi`. Existing examples include:

- Route-level mutation transaction: [frontend/app/api/books/route.ts:103](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:103).
- Orchestrator-level transaction after expensive external work: [frontend/lib/server/recommendRun.ts:140](/home/chase/Documents/Code/my-library/frontend/lib/server/recommendRun.ts:140).
- Profile service transaction: [frontend/lib/server/profileBuild.ts:264](/home/chase/Documents/Code/my-library/frontend/lib/server/profileBuild.ts:264).

For `/discover` specifically, the correct parity observation is “no wrapper goes anywhere.”

### Test and parity wiring

- Route contract tests call the exported `POST` handler directly, install a PGlite DB through `_setDbForTests()`, load the shared seed, and exercise validation/error/success behavior ([frontend/lib/server/__tests__/discover-route.test.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/discover-route.test.ts:1)).
- Run-level behavior is tested in `frontend/lib/server/__tests__/discover-run.test.ts`.
- Filter/retrieval behavior is tested in `frontend/lib/server/__tests__/rec-discover-filters.test.ts`.
- Rate-limit behavior is tested through the actual handler in `frontend/lib/server/__tests__/ratelimit-routes.test.ts`.
- Prompt parity reads Python-generated fixtures from `fixtures/claude/prompts.json` and compares models, tool definitions, messages, tool choice, and deterministic retrieval inputs in [frontend/lib/server/__tests__/parity-discover-prompts.test.ts:42](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/parity-discover-prompts.test.ts:42).
- Catalog replay uses `fixtures/catalog/http.json` and `fixtures/catalog/expected.json`, installed through the HTTP replay helper imported by the route test ([frontend/lib/server/__tests__/discover-route.test.ts:5](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/discover-route.test.ts:5)).
- Shared Python-response/DB fixtures live under `frontend/lib/server/__tests__/fixtures/parity/`; PGlite loading is wired through `helpers/pglite.ts`, while common parity environment setup is in `helpers/parity.ts` ([frontend/lib/server/__tests__/discover-route.test.ts:2](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/discover-route.test.ts:2)).

## 6. Backend switcher

The route table is `NODE_DEFAULT_ROUTES` in [frontend/lib/backend.ts:31](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:31).

Behavior:

- `auto`: routes matching a Node rule use same-origin `/api`; everything else uses `NEXT_PUBLIC_API_URL`.
- `python`: forces the Python base except for Node-only prefixes.
- `node`: forces `/api`.
- Rules can be prefix-wide, method-restricted, and exact-path-only.
- Query strings are removed before exact matching.

See [frontend/lib/backend.ts:8](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:8) and [frontend/lib/backend.ts:79](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:79).

A wave flips a route by:

1. Adding its Next route handler under `frontend/app/api/.../route.ts`.
2. Adding or extending the matching `NODE_DEFAULT_ROUTES` rule with the correct method and `exact` semantics.
3. Updating the exact-table and behavior assertions in [frontend/lib/__tests__/backend.test.ts:75](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:75).

Current tests explicitly preserve Wave 4 on Python:

- `DELETE /library` and `DELETE /account`: [frontend/lib/__tests__/backend.test.ts:46](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:46)
- `DELETE /profile`: [frontend/lib/__tests__/backend.test.ts:128](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:128)
- `GET /export`: [frontend/lib/__tests__/backend.test.ts:52](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:52)
- `POST /enrich/start`: [frontend/lib/__tests__/backend.test.ts:114](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:114)

The `/profile` Wave 4 delete requires a method-specific rule: existing POST and GET/PATCH rules do not capture DELETE ([frontend/lib/backend.ts:44](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:44), [frontend/lib/backend.ts:52](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:52)).

## 7. Wave 4 gaps with no Node equivalent

At inventory time there were no `frontend/app/api` route handlers for any of these paths; the first two were subsequently deleted in wave 4b rather than ported:

- `/ingest` (deleted in wave 4b)
- `/ingest/upload` (deleted in wave 4b)
- `/import/preview`
- `/import`
- `/export`
- `/enrich`
- `/enrich/start`
- `/enrich/status/[job_id]`
- `/library`
- `/account`
- `DELETE /profile`—the file `app/api/profile/route.ts` exists for other methods, but not this deletion behavior.

Infrastructure/domain gaps:

1. **No Node import/parser service.**  
   There is no TypeScript equivalent of `ImportRow`, format detection, Goodreads/StoryGraph/canonical/generic parsing, mapping suggestion, or the shared deduplicating upsert. The frontend currently has only client-side request/response types and multipart calls ([frontend/lib/api.ts:211](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:211), [frontend/lib/api.ts:504](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:504)).

2. **No Node export service.**  
   The browser download client exists ([frontend/lib/api.ts:637](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:637)), but there is no Next route producing canonical CSV, JSON backups, attachment headers, or effective-rating serialization.

3. **No Node enrichment resolver/orchestrator.**  
   Node has catalog/recommendation code used by Waves 1–3, but no port of `enrich_library()`’s ISBN/search resolution order, confidence scoring, enrichment upserts, forced reruns, existing-row skipping, or progress callback.

4. **No Node background execution mechanism.**  
   The `enrich_jobs` table is present in the introspected schema ([frontend/lib/server/schema.ts:153](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:153)), but there is no Node job creator, runner, queue consumer, stale-job recovery, restart recovery, or status route. The existing Next handlers demonstrate long request duration via `maxDuration`, but `/discover` still completes inside one HTTP request ([frontend/app/api/discover/route.ts:8](/home/chase/Documents/Code/my-library/frontend/app/api/discover/route.ts:8)); it is not a detached-work precedent.

5. **No Node equivalent of FastAPI `BackgroundTasks` or arq integration.**  
   Python supports both in-process detached work and Redis/arq ([mylibrary/api.py:576](/home/chase/Documents/Code/my-library/mylibrary/api.py:576)). No corresponding worker entry point, durable queue integration, or after-response lifecycle exists under `frontend/`.

6. **No Node purge service.**  
   Individual book deletion exists, but no atomic user-wide deletion service implements the explicit enrichment-before-books ordering, shared profile cascade, per-table counts, or the distinct durability policies of the three purge routes.

7. **No Wave 4 parity fixtures/tests.**  
   Existing Python tests define the expected behaviors—import invariants, formats, exports, jobs, and purges—but there are no corresponding Node route/service parity tests under `frontend/lib/server/__tests__`. Relevant Python specifications are:
   - [tests/test_ingest.py](/home/chase/Documents/Code/my-library/tests/test_ingest.py)
   - [tests/test_importers.py](/home/chase/Documents/Code/my-library/tests/test_importers.py)
   - [tests/test_import_api.py](/home/chase/Documents/Code/my-library/tests/test_import_api.py)
   - [tests/test_export.py](/home/chase/Documents/Code/my-library/tests/test_export.py)
   - [tests/test_jobs.py](/home/chase/Documents/Code/my-library/tests/test_jobs.py)
   - [tests/test_enrich.py](/home/chase/Documents/Code/my-library/tests/test_enrich.py)
   - [tests/test_purge.py](/home/chase/Documents/Code/my-library/tests/test_purge.py)

No files were modified.

Codex session ID: 019fee81-6517-7450-88ca-4c28d2953652
Resume in Codex: codex resume 019fee81-6517-7450-88ca-4c28d2953652
