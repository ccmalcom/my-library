# Node Backend Wave 4b — Import / Export Implementation Plan

> **For agentic workers:** REQUIRED EXECUTION PATH: follow the `CLAUDE.md:114-148` Claude / Codex split. Claude owns planning and judgement; send each implementation task verbatim to `/codex:rescue --background <task text>`, review the resulting diff, and let Chase commit and merge by hand. Enable the review gate at the start of execution. Never commit, cherry-pick, merge, push, or deploy from an agent session.

**Goal:** Port exactly `POST /import/preview`, `POST /import`, and `GET /export` from FastAPI to authenticated Next.js route handlers, preserving Python's CSV, JSON, counter, date, deduplication, and never-clobber behavior byte-for-byte where observable; then remove the dead HTTP ingest surface completely.

**Architecture:** Add a server-only CSV/import core shared by preview and import, with `csv-parse` configured to reproduce `csv.DictReader` and a transaction-only upsert helper used by one route-owned transaction. Add a separate exporter using `csv-stringify` with an explicitly pinned Python `excel` dialect and an ordered JSON serializer. Extend the parity recorder before the routes so multipart requests and raw attachment bytes/headers can become golden fixtures. Keep uploads in memory, enforce one explicit 10 MiB limit in the shared upload helper, and declare the Node runtime on both multipart routes.

**Tech Stack:** Next.js route handlers, TypeScript, Drizzle over postgres-js, `csv-parse ^7.0.2`, `csv-stringify ^6.8.3`, Vitest + PGlite, Jest backend-switcher tests, FastAPI TestClient parity fixtures, pytest.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Wave 4b is three routes only:** `POST /import/preview`, `POST /import`, and `GET /export`. `POST /ingest` and `POST /ingest/upload` are deleted, never ported. Enrichment (`POST /enrich`, `POST /enrich/start`, `GET /enrich/status/{job_id}`) is wave 4c and remains blocked on the background-execution architecture decision; do not add jobs, queues, workers, polling, or enrichment code. Admin routes and Python cutover are wave 5; do not plan or change them.
2. **Python is the specification.** `mylibrary/importers/core.py`, `mylibrary/importers/formats.py`, `mylibrary/exporters.py`, the wrappers at `mylibrary/api.py:480-563`, and their Python tests are authoritative. Reproduce quirks; do not repair them in Node.
3. **Never clobber owned feedback.** Locked decision #2 at `CLAUDE.md:181-184` is the highest-priority invariant: an existing book's `app_rating`, `app_review`, and `feedback_updated_at` are never written by import. The update tuple is exactly `author`, `additionalAuthors`, `isbn13`, `exclusiveShelf`, `dateRead`, `dateAdded`, `pageCount`, `yearPublished`, `goodreadsRating`, and each value is assigned only when non-`null`.
4. **One import request, one transaction.** Decode, parse, and validate before the transaction. `POST /import` then opens exactly one `db.transaction(async (tx) => ...)` around the complete existing-book load and row loop. The shared upsert accepts the existing `DbTx` from `frontend/lib/server/db.ts:13-14`, never calls `getDb()`, and never opens a transaction. This follows the placement used by existing Node writes at `frontend/app/api/books/route.ts:90-140`.
5. **Counters are UI contracts.** Preserve `format`, `total_rows`, `skipped`, `inserted`, `updated`, and `rated` exactly. Every CSV data record increments `total_rows`; a blank-title record additionally increments `skipped`; each parsed row increments exactly one of `inserted`/`updated`; a truthy normalized rating additionally increments `rated`. Thus one physical row may increment two or three counters.
6. **CSV dependencies are decided.** Add exactly `csv-parse ^7.0.2` and `csv-stringify ^6.8.3` as server-only runtime dependencies. Add no `@types` packages. Their defaults are not parity: every parse/stringify call must use the pinned option objects in Task 1.
7. **Byte-exact backup parity is required.** CSV is the canonical, re-importable backup. Pin column order, comma delimiter, `"` quote, doubled embedded quotes, minimal quoting, `\r\n`, and `""` for absent values. JSON must preserve top-level, book, and signal key order, integer version `1`, Python indentation/separators, Python-compatible Unicode escaping, and UTC timestamp shape. Shape-only tests are insufficient.
8. **Rounding has two distinct rules.** Existing `round2`/`round4` use banker's rounding through `pyRound` (`frontend/lib/server/serialize.ts:1-41`) and remain unchanged. Import stars use Python's nonnegative `int(value + 0.5)` half-up rule (`mylibrary/importers/core.py:59-76`); add `roundRatingHalfUp` beside those helpers and do not call `pyRound` from import parsing.
9. **Dates are date-only strings.** Import parsing returns `YYYY-MM-DD | null` and writes the Drizzle `date` columns as strings. Note the schema declares these bare — `grep -n 'dateRead: date' frontend/lib/server/schema.ts` shows `date("date_read")` with **no** config object, unlike the timestamp columns which do pass `{ mode: 'string' }` explicitly. That is correct and must not be "fixed": drizzle's `date()` overload returns `PgDateStringBuilderInitial` unless the mode is explicitly `'date'`, so the bare form is already string mode and the column type is `string`. Do not add a `{ mode: 'string' }` option, and do not conclude the plan is wrong when grepping for one. Never construct a JavaScript `Date` for imported dates. JSON export emits stored date strings unchanged. Test under `TZ=America/Los_Angeles` with `01/01/2026`, which naive UTC parsing can display as `2025-12-31` locally.
10. **Uploads are deliberately in-memory.** Both routes call `await request.formData()`, require `form.get('file') instanceof File`, require a case-insensitive `.csv` filename, then read `await file.arrayBuffer()` and decode with a fatal UTF-8 decoder after stripping one leading BOM. `MAX_IMPORT_BYTES = 10 * 1024 * 1024` lives in `frontend/lib/server/import-upload.ts`; reject an over-limit `Content-Length` before `formData()` and reject `file.size` afterward with `413`. Both route files declare `export const runtime = 'nodejs'`. There is no repository multipart precedent (`frontend/lib/api.ts:504-540`) and no attachment precedent beyond an empty 204 (`frontend/app/api/feedback/dismiss/route.ts:23`), so do not cite one.
11. **`withApi` already supports attachments.** Its callback returns `Promise<Response>` and it returns that raw response after adding optional debug headers (`frontend/lib/server/http.ts:35-39`, `:78-94`). `GET /export` needs no wrapper change.
12. **Complete runnable tests only.** Every test added by this plan contains real setup, invocation, and whole-object/whole-byte assertions. Do not replace a body with comments or partial-field assertions. Put server and route tests under `frontend/lib/server/**/*.test.ts` or `frontend/app/api/**/*.test.ts` for Vitest; Jest explicitly excludes those paths (`frontend/vitest.config.ts:4-7`; `frontend/jest.config.js:4-10`).
13. **The parity harness is a prerequisite.** Extend both record and replay before route work. Record real FastAPI multipart responses and real export bytes plus `Content-Type`/`Content-Disposition`; do not manufacture the golden export in TypeScript.
14. **Dead ingest means no orphan.** Remove both Python HTTP handlers, `api.ingestUpload`, switcher/test references if found, and every documentation reference that describes the HTTP routes as live. Keep `mylibrary.ingest.ingest_csv` and the CLI `ingest` command.
15. Run `npx prettier --write` only on touched frontend/JSON/Markdown files. Never format the repository. Chase commits by hand; no task runs git commit, cherry-pick, merge, push, or deploy.

---

## Verified Facts

Every row below was checked against the current repository, not accepted from an inventory sketch.

| #   | Fact                                                                                                                                                                                                                                                         | Evidence                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| V1  | Preview and import are authenticated multipart endpoints with required field `file`; import also accepts `format` and JSON-string `mapping`.                                                                                                                 | `mylibrary/api.py:491-513`                                                                                       |
| V2  | Upload names are lowercased for `.csv` validation and bytes decode as `utf-8-sig`; exact fixed errors are `Uploaded file must be a .csv` and `File must be UTF-8 encoded CSV.`                                                                               | `mylibrary/api.py:480-488`                                                                                       |
| V3  | Preview key order is `format`, `headers`, `sample_rows`, `suggested_mapping`; mapping key order is `title`, `author`, `isbn13`, `rating`, `review`, `shelf`, `date_read`.                                                                                    | `mylibrary/schemas.py:480-488`; `mylibrary/importers/formats.py:30`, `:196-204`                                  |
| V4  | Format detection precedence is Goodreads, StoryGraph, canonical, unknown after the documented trim/case transforms.                                                                                                                                          | `mylibrary/importers/formats.py:145-154`                                                                         |
| V5  | Python uses `csv.DictReader(io.StringIO(text))`; headers preserve order/text, samples stop at five and coerce falsey/missing values to `""`.                                                                                                                 | `mylibrary/importers/formats.py:46-64`                                                                           |
| V6  | All four parsers count each CSV data record before blank-title skipping.                                                                                                                                                                                     | `mylibrary/importers/formats.py:77-106`, `:117-142`, `:157-181`, `:207-235`                                      |
| V7  | Rating normalization is half-up for nonnegative values, drops nonpositive/invalid values, and caps at five.                                                                                                                                                  | `mylibrary/importers/core.py:59-76`; `tests/test_importers.py:45-53`                                             |
| V8  | Date parsing accepts `%Y/%m/%d`, `%Y-%m-%d`, `%m/%d/%Y` and returns a date, not a datetime.                                                                                                                                                                  | `mylibrary/importers/core.py:45-56`                                                                              |
| V9  | Existing-book lookup is tenant-scoped with precedence external ID only; otherwise ISBN then normalized title plus author surname. Same-batch inserts are added to the indexes.                                                                               | `mylibrary/importers/core.py:146-167`, `:203-211`                                                                |
| V10 | The exact update-eligible tuple excludes `title`, `goodreads_book_id`, `source`, `app_rating`, `app_review`, and `feedback_updated_at`; only non-`None` values assign.                                                                                       | `mylibrary/importers/core.py:121-132`, `:169-179`, `:213-218`                                                    |
| V11 | A non-Goodreads review seeds `app_review` only for a fresh insert and only with a rating; `app_rating` stays unset and `feedback_updated_at` is set.                                                                                                         | `mylibrary/importers/formats.py:95-97`; `mylibrary/importers/core.py:181-202`                                    |
| V12 | Import summary key order is `format`, `total_rows`, `skipped`, `inserted`, `updated`, `rated`.                                                                                                                                                               | `mylibrary/importers/formats.py:245-273`; `mylibrary/schemas.py:489-497`                                         |
| V13 | CSV export order is `title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published`; absent values are empty strings.                                                                                            | `mylibrary/importers/formats.py:32-35`; `mylibrary/exporters.py:22-50`                                           |
| V14 | Python `DictWriter` uses the default `excel` dialect and always writes a header: comma delimiter, minimal quoting, doubled quotes, and CRLF records.                                                                                                         | `mylibrary/exporters.py:24-26`; Python `csv` behavior locked by Task 1's golden edge fixture                     |
| V15 | CSV books and JSON books are ordered by `Book.id`; JSON signals are ordered by `TasteSignal.id`.                                                                                                                                                             | `mylibrary/exporters.py:27-32`, `:55-63`                                                                         |
| V16 | JSON top-level order is `version`, `exported_at`, `books`, `taste_signals`; exact nested orders are visible in the literal dictionaries.                                                                                                                     | `mylibrary/exporters.py:65-98`                                                                                   |
| V17 | `exported_at` uses aware UTC `.isoformat()` and JSON endpoint uses `json.dumps(..., indent=2)` without an added newline.                                                                                                                                     | `mylibrary/exporters.py:65-67`; `mylibrary/api.py:553-559`                                                       |
| V18 | Export filenames use current UTC `YYYYMMDD`; bad formats return 422 with `format must be 'csv' or 'json'.`.                                                                                                                                                  | `mylibrary/api.py:541-563`                                                                                       |
| V19 | No Next handler reads `formData()`/`File` or returns an attachment; `withApi` accepts and returns raw `Response`.                                                                                                                                            | repository `rg`; `frontend/app/api/feedback/dismiss/route.ts:23`; `frontend/lib/server/http.ts:35-39`, `:93-94`  |
| V20 | The Python recorder sends only JSON and parses every nonempty body as JSON.                                                                                                                                                                                  | `scripts/gen_parity_fixtures.py:399-415`                                                                         |
| V21 | Node write replay constructs only JSON requests and calls `res.json()`.                                                                                                                                                                                      | `frontend/lib/server/__tests__/helpers/write-parity.ts:95-120`                                                   |
| V22 | `DbTx` already exists; no new transaction type is required.                                                                                                                                                                                                  | `frontend/lib/server/db.ts:13-14`                                                                                |
| V23 | The live dead-ingest references are the two Python decorators, the compatibility docstring, `api.ingestUpload`, README API list, two old direct-fetch plan notes, wave-3 verification, and both inventories; no ingest switcher row or URL assertion exists. | `mylibrary/api.py:435-469`; `mylibrary/ingest.py:1-4`; `frontend/lib/api.ts:504-513`; repository `rg -n '/ingest | ingestUpload'` |
| V24 | Auto mode still pins `/import` and `/export` to Python, and the complete route-list snapshot ends with wave 4a.                                                                                                                                              | `frontend/lib/__tests__/backend.test.ts:46-52`, `:74-98`; `frontend/lib/backend.ts:59-64`                        |
| V25 | `csv-parse` and `csv-stringify` are absent; the package has no CSV dependency.                                                                                                                                                                               | `frontend/package.json:17-30`                                                                                    |

### Python quirks to reproduce, not fix

- A Goodreads `My Review` is ignored. StoryGraph, canonical, and generic reviews may seed `app_review`, but only on insert with a truthy rating.
- Goodreads rating uses tolerant integer parsing (`int(float(s))`) rather than star half-up parsing. StoryGraph/canonical/generic use half-up. `4.9` therefore becomes `4` in Goodreads and `5` elsewhere.
- An incoming external ID disables ISBN/title fallback even when no external-ID match exists. A new book is inserted.
- The title itself never updates on a match. New non-`null` import-owned values do; blank/unparseable values preserve stored values.
- `rated` is orthogonal to insert/update. A rated existing row increments both `rated` and `updated`; a blank-title row increments `total_rows` and `skipped` only.
- Python `DictReader` represents too-few cells as missing/`None`, while extra cells live under a `None` key; application field lookup ignores extras and preview stringifies the extra-key property as `"None"` through Pydantic. Lock the actual golden response rather than improving ragged rows.
- The CSV export uses effective rating (`app_rating` when non-null, else truthy `goodreads_rating`, else empty), but always exports `app_review`; re-import stores that effective rating in `goodreads_rating` and may seed the review on a new row.
- Python JSON escaping defaults to `ensure_ascii=True`: non-ASCII characters are `\uXXXX` escapes and supplementary characters use surrogate pairs. Do not use plain pretty `JSON.stringify` without a Python-compatible escape pass.
- Python UTC timestamps normally carry six fractional digits and `+00:00`; JavaScript `Date#toISOString()` has three digits and `Z`. Generate the six-digit `+00:00` shape explicitly, and mask only the value—not formatting—in parity tests.

---

## File Structure

**New files**

| File                                                         | Responsibility                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `frontend/lib/server/import-csv.ts`                          | Pinned CSV reader options, normalization, format parsers, preview helpers   |
| `frontend/lib/server/import-upload.ts`                       | Multipart extraction, 10 MiB limit, filename and fatal UTF-8/BOM validation |
| `frontend/lib/server/import-books.ts`                        | Transaction-only dedup/upsert core and exact counters                       |
| `frontend/lib/server/export.ts`                              | Ordered CSV/JSON backup construction and Python JSON rendering              |
| `frontend/app/api/import/preview/route.ts`                   | Authenticated multipart preview                                             |
| `frontend/app/api/import/route.ts`                           | Authenticated multipart import with one transaction                         |
| `frontend/app/api/export/route.ts`                           | Authenticated raw attachment response                                       |
| `frontend/lib/server/__tests__/import-csv.test.ts`           | CSV dialect edge matrix, parsers, normalization, date and counters          |
| `frontend/lib/server/__tests__/import-books.test.ts`         | Whole-row insert/update, never-clobber, dedup and transaction tests         |
| `frontend/lib/server/__tests__/import-export-routes.test.ts` | Real multipart routes, export bytes/headers, round-trip and tenant tests    |

**Modified files**

| File                                                                                  | Change                                                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `frontend/package.json`, `frontend/package-lock.json`                                 | Add exactly the two runtime CSV packages                                                 |
| `frontend/lib/server/serialize.ts`                                                    | Add the deliberately separate half-up rating helper and Python indented JSON helper      |
| `scripts/gen_parity_fixtures.py`                                                      | Describe multipart steps and capture raw body bytes/text plus selected headers           |
| `frontend/lib/server/__tests__/helpers/write-parity.ts`                               | Replay multipart and compare raw bodies/headers                                          |
| `frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json`                  | Real FastAPI preview/import/export goldens                                               |
| `frontend/lib/server/__tests__/parity-import-export.test.ts`                          | Register and replay all three handlers                                                   |
| `frontend/lib/api.ts`                                                                 | Remove dead `ingestUpload`; retain import methods                                        |
| `mylibrary/api.py`                                                                    | Remove only `/ingest` and `/ingest/upload` handlers/imports made unused                  |
| `mylibrary/ingest.py`                                                                 | Remove HTTP-route wording; keep CLI compatibility implementation                         |
| `frontend/lib/backend.ts`                                                             | Add three exact method-specific wave-4b rows                                             |
| `frontend/lib/__tests__/backend.test.ts`                                              | Flip all assertions and complete ordered snapshot                                        |
| `README.md`, `CLAUDE.md`, old migration/verification docs and both wave-4 inventories | Remove or mark dead HTTP ingest references; record 4b boundary without rewriting history |

**Dependency order:** Task 1 (CSV dependencies/options) → Task 2 (multipart/raw parity harness) → Task 3 (shared parser/upsert core) → Task 4 (preview route) → Task 5 (import route) → Task 6 (export + round-trip) → Task 7 (dead-ingest removal) → Task 8 (switcher/docs) → Task 9 (full verification). Tasks 1 and 2 precede every route because the routes depend on those contracts; Task 3 precedes both import routes because they share parsing and import owns the upsert; the switcher changes last because flipping before handlers exist makes the intentionally strict Jest assertions fail.

---

## Task 1: Install and lock the Python-compatible CSV layer

**Files:** `frontend/package.json`, `frontend/package-lock.json`, `frontend/lib/server/import-csv.ts`, `frontend/lib/server/serialize.ts`, `frontend/lib/server/__tests__/import-csv.test.ts`

- [ ] **Step 1: Add exactly the decided runtime dependencies**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm install csv-parse@^7.0.2 csv-stringify@^6.8.3
```

Confirm both are under `dependencies`, no `@types/csv-*` exists, and the lockfile contains resolved versions satisfying those ranges.

- [ ] **Step 2: Write the complete CPython edge-matrix test before the wrapper**

```ts
// frontend/lib/server/__tests__/import-csv.test.ts
import { describe, expect, test } from "vitest";
import { parseCsvRecords, stringifyCanonical } from "../import-csv";

describe("Python csv compatibility", () => {
  test("matches DictReader/DictWriter on quoting, newlines, BOM, ragged rows, and trailing blank line", () => {
    const text =
      '\uFEFFa,b,c\r\n"x,y","say ""hi""","line1\nline2"\r\nplain,"lone\rreturn"\r\nshort,only\r\ntoo,many,cells,EXTRA\r\n\r\n';
    expect(parseCsvRecords(text)).toEqual({
      headers: ["a", "b", "c"],
      rows: [
        { a: "x,y", b: 'say "hi"', c: "line1\nline2" },
        { a: "plain", b: "lone\rreturn", c: null },
        { a: "short", b: "only", c: null },
        { a: "too", b: "many", c: "cells", __extra: ["EXTRA"] },
      ],
    });
    expect(
      stringifyCanonical([
        {
          title: "x,y",
          author: 'say "hi"',
          additional_authors: "line1\nline2",
          isbn13: "lone\rreturn",
          shelf: "",
          rating: "",
          review: "",
          date_read: "",
          date_added: "",
          page_count: "",
          year_published: "",
        },
      ]),
    ).toBe(
      "title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n" +
        '"x,y","say ""hi""","line1\nline2","lone\rreturn",,,,,,,\r\n',
    );
  });
});
```

This single fixture covers every required differentiator. Its expected parse comes from `csv.DictReader` behavior at `mylibrary/importers/formats.py:46-48`; its expected write bytes come from `csv.DictWriter` at `mylibrary/exporters.py:24-49`.

**Corrected 2026-08-11 against real CPython output — two byte-significant fixes:**

1. **`lone\rreturn` is quoted, not bare.** CPython's `excel` dialect is `QUOTE_MINIMAL`, and minimal quoting triggers on the delimiter, the quotechar, **or any character in `lineterminator`** — which for `excel` is `\r\n`. A lone `\r` is therefore a quote-forcing character. Verified:

   ```
   >>> csv.DictWriter(buf, CANONICAL).writerow({..., 'isbn13': 'lone\rreturn', ...})
   '...,"line1\nline2","lone\rreturn",,,,,,,\r\n'
   ```

   This matters beyond the test: `csv-stringify`'s minimal quoting may only consider the full `record_delimiter` string and miss a bare `\r`. If `quoted: false` alone does not reproduce the quoted form, make the wrapper force it (e.g. `quoted_match: /[\r\n]/`) — **CPython is the specification; never relax the expectation to match `csv-stringify`'s default.** The same fix applies to Task 6's `A\rB` column.

2. **The BOM expectation is correct as written, at this layer.** `csv.DictReader(io.StringIO(text))` in isolation does **not** strip a BOM — it yields `fieldnames == ['﻿a', 'b', 'c']`. That is not the pipeline's behavior: `mylibrary/api.py:486` decodes `raw.decode("utf-8-sig")` in `_decode_upload` **before** the text ever reaches `formats.py:48`, so end-to-end Python yields `['a', 'b', 'c']`. Verified both ways. `bom: true` in `PY_DICT_READER_OPTIONS` reproduces the composed pipeline in one step, and it is harmlessly redundant with the upload helper's BOM strip (Global Constraint 10) because there is only ever one leading BOM. Keep `headers: ["a", "b", "c"]`; do not "fix" it to `﻿a`. Add a comment in the test recording that the BOM strip is `utf-8-sig`'s job in Python and the reader's job here.

- [ ] **Step 3: Implement one pinned parse option object**

```ts
export const PY_DICT_READER_OPTIONS = {
  bom: true,
  columns: true,
  delimiter: ",",
  quote: '"',
  escape: '"',
  relax_column_count: true,
  skip_empty_lines: true,
  record_delimiter: ["\r\n", "\n", "\r"],
} as const;
```

Call `parse(text, PY_DICT_READER_OPTIONS)` once, preserve header order via a separate first-record parse or `columns(headers)`, normalize missing cells to `null`, and preserve extras internally as `__extra` only so preview can reproduce the recorded Python golden. Do not enable trimming: Python preserves cell/header bytes and each importer trims only named fields.

- [ ] **Step 4: Implement one pinned writer option object**

```ts
export const PY_EXCEL_WRITER_OPTIONS = {
  header: true,
  columns: CANONICAL_FIELDS,
  delimiter: ",",
  quote: '"',
  escape: '"',
  quoted: false,
  quoted_empty: false,
  record_delimiter: "\r\n",
  eof: true,
} as const;
```

Minimal quoting is intentional: only fields requiring quotes are quoted; internal quotes double. `record_delimiter` is explicitly CRLF because `csv-stringify` does not default to Python's `excel` terminator.

- [ ] **Step 5: Add a separate half-up helper and prove it differs from `pyRound`**

```ts
export function roundRatingHalfUp(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.trunc(value + 0.5);
  return rounded <= 0 ? null : Math.min(rounded, 5);
}

test("star rounding is half-up, not Python banker rounding", () => {
  expect(roundRatingHalfUp(4.5)).toBe(5);
  expect(roundRatingHalfUp(4.4)).toBe(4);
  expect(roundRatingHalfUp(0.4)).toBeNull();
  expect(roundRatingHalfUp(9)).toBe(5);
  expect(pyRoundHalfEven(4.5)).toBe(4);
});
```

**Corrected 2026-08-11:** the contrast assertion was originally written as `pyRound(4.5, 0)`, but `pyRound` is module-private — `frontend/lib/server/serialize.ts:54` declares it as a bare `function pyRound(...)`, and only the `round2`/`round4`/`pyRoundHalfEven` wrappers are exported. Use the already-exported `pyRoundHalfEven`, which **is** Python's one-argument `round(x) -> int` (half-to-even) and is exactly the contrast this assertion wants. Do **not** widen `serialize.ts`'s public surface by exporting `pyRound` just to satisfy a test.

- [ ] **Step 6: Run, prove symbols landed, and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/import-csv.test.ts
grep -n 'PY_DICT_READER_OPTIONS' lib/server/import-csv.ts
grep -n 'record_delimiter.*\\r\\n' lib/server/import-csv.ts
grep -n 'roundRatingHalfUp' lib/server/serialize.ts
npx prettier --write package.json package-lock.json lib/server/import-csv.ts lib/server/serialize.ts lib/server/__tests__/import-csv.test.ts
```

Expected: PASS. Diff ready for Chase's review; do not commit.

---

## Task 2: Extend the parity recorder for multipart requests and raw attachments

**Files:** `scripts/gen_parity_fixtures.py`, `frontend/lib/server/__tests__/helpers/write-parity.ts`, `frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json`, `frontend/lib/server/__tests__/parity-import-export.test.ts`

- [ ] **Step 1: Add explicit fixture schema fields**

Each scenario step may carry `multipart: {file: {filename, content, content_type}, fields}`, `response_mode: "json" | "text" | "base64"`, and `response_headers: ["content-type", "content-disposition"]`. Keep existing `json` scenarios backward-compatible.

- [ ] **Step 2: Extend Python recording before adding scenarios**

```py
multipart = step.get("multipart")
files = None
data = None
if multipart:
    f = multipart["file"]
    files = {"file": (f["filename"], f["content"].encode("utf-8"), f.get("content_type", "text/csv"))}
    data = multipart.get("fields", {})
r = client.request(method, path, json=step.get("json"), files=files, data=data)
mode = step.get("response_mode", "json")
body = (None if r.status_code == 204 or not r.content else
        base64.b64encode(r.content).decode("ascii") if mode == "base64" else
        r.text if mode == "text" else r.json())
headers = {name: r.headers.get(name) for name in step.get("response_headers", [])}
```

Record `multipart`, `response_mode`, and `headers` into each output step. Import `base64` at module scope.

- [ ] **Step 3: Extend Node replay with real `FormData` and raw comparisons**

```ts
const form = step.multipart ? new FormData() : null;
if (form) {
  for (const [key, value] of Object.entries(step.multipart.fields ?? {}))
    form.set(key, value);
  const f = step.multipart.file;
  form.set(
    "file",
    new File([f.content], f.filename, { type: f.content_type ?? "text/csv" }),
  );
}
const req = new Request(`http://test/api${pathAndQuery}`, {
  method,
  headers: step.json != null ? { "content-type": "application/json" } : {},
  body: form ?? (step.json != null ? JSON.stringify(step.json) : undefined),
});
const res = await handler(req, { params });
expect(
  Object.fromEntries(
    Object.keys(step.headers ?? {}).map((k) => [k, res.headers.get(k)]),
  ),
).toEqual(step.headers ?? {});
const body =
  step.response_mode === "base64"
    ? Buffer.from(await res.arrayBuffer()).toString("base64")
    : step.response_mode === "text"
      ? await res.text()
      : await res.json();
expect(maskVolatile(body)).toEqual(maskVolatile(step.body));
```

- [ ] **Step 4: Add real wave-4b golden scenarios**

Add: StoryGraph preview; generic mapped import; CSV export; JSON export; invalid export format. CSV export uses `response_mode: "base64"` and both response headers. JSON export uses `response_mode: "text"`, both headers, and a targeted timestamp mask that preserves `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` syntax.

- [ ] **Step 5: Generate from FastAPI and prove raw fields exist**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/python scripts/gen_parity_fixtures.py
grep -n '"response_mode": "base64"' frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json
grep -n '"content-disposition"' frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json
```

- [ ] **Step 6: Run existing replay regression and format only touched files**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-writes-books.test.ts
npx prettier --write lib/server/__tests__/helpers/write-parity.ts lib/server/__tests__/fixtures/parity/write-scenarios.json lib/server/__tests__/parity-import-export.test.ts
```

The new route replay remains red until Tasks 4-6; old scenarios must stay green. Diff ready for review.

---

## Task 3: Build and test the shared parser and transaction-only upsert core

**Files:** `frontend/lib/server/import-csv.ts`, `frontend/lib/server/import-books.ts`, `frontend/lib/server/__tests__/import-csv.test.ts`, `frontend/lib/server/__tests__/import-books.test.ts`

- [ ] **Step 1: Port normalization and all four parsers literally**

Define `ImportRow` with date-only strings and `null` optionals. Port `cleanIsbn`, tolerant `parseIntValue`, three-format `parseDateOnly`, `normalizeShelf`, author splitting, detection, preview, suggestions, Goodreads, StoryGraph, canonical, and generic mappings from `mylibrary/importers/core.py:22-118` and `mylibrary/importers/formats.py:23-242`. Keep `SOURCE_FOR` exact.

- [ ] **Step 2: Add the complete timezone/date test**

```ts
test("date parsing is timezone-free and cannot shift to the prior day", () => {
  process.env.TZ = "America/Los_Angeles";
  expect(parseDateOnly("01/01/2026")).toBe("2026-01-01");
  expect(parseDateOnly("2026/01/02")).toBe("2026-01-02");
  expect(parseDateOnly("2026-01-03")).toBe("2026-01-03");
  expect(parseDateOnly("2026-13-01")).toBeNull();
  expect(
    new Date("2026-01-01").toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
  ).toBe("12/31/2025");
});
```

**Corrected 2026-08-11:** this control assertion originally passed locale `en-CA` while expecting the
`en-US` format string `12/31/2025`. Modern ICU renders `en-CA` as ISO-like, so on Node v22.22.2 it
returns `2025-12-31` and the assertion fails. Verified:

```
en-CA default opts     : 2025-12-31
en-US default opts     : 12/31/2025
en-US explicit 2-digit : 12/31/2025
```

The assertion's *intent* was always sound — naive UTC parsing really does display `2026-01-01` as
December 31, 2025 in `America/Los_Angeles`, which is exactly the trap `parseDateOnly` must avoid. Only
the locale/expectation pairing was wrong. Use `en-US` **with explicit `year`/`month`/`day` numeric
options** rather than relying on the locale's default pattern, so the assertion does not depend on the
ICU version bundled with whatever Node runs the suite.

- [ ] **Step 3: Implement transaction-only dedup/upsert**

Use `DbTx`, `schema.books`, `eq`, and `and`. Load only `userId`. Maintain three maps across the loop. Use the exact update tuple and build a Drizzle `.set()` object from values `!== null`; never include `appRating`, `appReview`, or `feedbackUpdatedAt` for updates.

- [ ] **Step 4: Write the never-clobber tests as three whole-object assertions**

```ts
test("existing books update only the exact eligible non-null tuple", async () => {
  const [book] = await db
    .insert(schema.books)
    .values({
      userId: "local",
      goodreadsBookId: "7",
      title: "Owned Title",
      author: "Old Author",
      additionalAuthors: "Keep Me",
      isbn13: "OLD",
      exclusiveShelf: "read",
      goodreadsRating: 2,
      appRating: 5,
      appReview: "Owned review",
      feedbackUpdatedAt: "2026-01-02 03:04:05",
      dateRead: "2025-01-01",
      dateAdded: "2025-01-02",
      pageCount: 100,
      yearPublished: 1990,
      source: "manual",
    })
    .returning();
  await db.transaction((tx) =>
    importRows(tx, "local", "storygraph_import", [
      {
        title: "Incoming Title",
        author: "New Author",
        additionalAuthors: null,
        isbn13: "NEW",
        shelf: "to-read",
        rating: 4,
        review: "Must not clobber",
        dateRead: null,
        dateAdded: "2026-01-01",
        pageCount: 222,
        yearPublished: 2020,
        externalId: "7",
      },
    ]),
  );
  expect(
    (
      await db.select().from(schema.books).where(eq(schema.books.id, book.id))
    )[0],
  ).toEqual({
    ...book,
    author: "New Author",
    isbn13: "NEW",
    exclusiveShelf: "to-read",
    goodreadsRating: 4,
    dateAdded: "2026-01-01",
    pageCount: 222,
    yearPublished: 2020,
  });
});

test("fresh rated non-Goodreads insert seeds review but leaves app rating null", async () => {
  await db.transaction((tx) =>
    importRows(tx, "local", "storygraph_import", [
      {
        title: "Seeded",
        author: "A Writer",
        additionalAuthors: null,
        isbn13: null,
        shelf: "read",
        rating: 5,
        review: "Seed me",
        dateRead: "2026-01-01",
        dateAdded: null,
        pageCount: null,
        yearPublished: null,
        externalId: null,
      },
    ]),
  );
  const [{ id: _id, ...row }] = await db.select().from(schema.books);
  expect(row).toEqual({
    userId: "local",
    goodreadsBookId: null,
    title: "Seeded",
    author: "A Writer",
    additionalAuthors: null,
    isbn13: null,
    exclusiveShelf: "read",
    goodreadsRating: 5,
    appRating: null,
    appReview: "Seed me",
    feedbackUpdatedAt: expect.any(String),
    dateRead: "2026-01-01",
    dateAdded: null,
    pageCount: null,
    yearPublished: null,
    source: "storygraph_import",
    excludeFromProfile: false,
    isFavorite: false,
  });
});

test("fresh review without a rating does not seed owned feedback fields", async () => {
  await db.transaction((tx) =>
    importRows(tx, "local", "canonical_import", [
      {
        title: "Unrated",
        author: null,
        additionalAuthors: null,
        isbn13: null,
        shelf: null,
        rating: null,
        review: "No rating",
        dateRead: null,
        dateAdded: null,
        pageCount: null,
        yearPublished: null,
        externalId: null,
      },
    ]),
  );
  const [{ id: _id, ...row }] = await db.select().from(schema.books);
  expect(row).toEqual({
    userId: "local",
    goodreadsBookId: null,
    title: "Unrated",
    author: null,
    additionalAuthors: null,
    isbn13: null,
    exclusiveShelf: null,
    goodreadsRating: 0,
    appRating: null,
    appReview: null,
    feedbackUpdatedAt: null,
    dateRead: null,
    dateAdded: null,
    pageCount: null,
    yearPublished: null,
    source: "canonical_import",
    excludeFromProfile: false,
    isFavorite: false,
  });
});
```

- [ ] **Step 5: Add exact counter and rollback tests**

```ts
test("counters allow skipped and rated rows to increment orthogonally", async () => {
  const parsed = parseCanonical(
    "title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n,, ,,,5,,,,,\r\nDune,Frank Herbert,,,read,5,,,,,\r\nDune,Frank Herbert,,,to-read,4,,,,,\r\n",
  );
  const counts = await db.transaction((tx) =>
    importRows(tx, "local", "canonical_import", parsed.rows),
  );
  expect({
    format: parsed.format,
    total_rows: parsed.totalRows,
    skipped: parsed.skipped,
    ...counts,
  }).toEqual({
    format: "canonical",
    total_rows: 3,
    skipped: 1,
    inserted: 1,
    updated: 1,
    rated: 2,
  });
});

test("one transaction rolls back the complete row loop", async () => {
  await expect(
    db.transaction(async (tx) => {
      await importRows(tx, "local", "canonical_import", [row("First")]);
      throw new Error("rollback probe");
    }),
  ).rejects.toThrow("rollback probe");
  expect(await db.select().from(schema.books)).toEqual([]);
});
```

Also add complete whole-object tests for external-ID-only precedence, ISBN precedence, title/surname fallback, same-batch dedup, Goodreads review omission, and cross-tenant isolation.

- [ ] **Step 6: Run, prove the guard, and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/import-csv.test.ts lib/server/__tests__/import-books.test.ts
grep -n 'UPDATE_ELIGIBLE_FIELDS' lib/server/import-books.ts
grep -n 'value !== null' lib/server/import-books.ts
npx prettier --write lib/server/import-csv.ts lib/server/import-books.ts lib/server/__tests__/import-csv.test.ts lib/server/__tests__/import-books.test.ts
```

Expected: PASS. Diff ready for review.

---

## Task 4: Add authenticated `POST /import/preview`

**Files:** `frontend/lib/server/import-upload.ts`, `frontend/app/api/import/preview/route.ts`, `frontend/lib/server/__tests__/import-export-routes.test.ts`

- [ ] **Step 1: Write complete multipart route tests**

```ts
test("POST preview returns the exact ordered StoryGraph preview object", async () => {
  const form = new FormData();
  form.set(
    "file",
    new File(
      [
        "Title,Authors,Read Status,Star Rating\r\nDune,Frank Herbert,Read,4.5\r\n",
      ],
      "books.CSV",
      { type: "text/csv" },
    ),
  );
  const res = await preview(
    new Request("http://test/api/import/preview", {
      method: "POST",
      body: form,
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    format: "storygraph",
    headers: ["Title", "Authors", "Read Status", "Star Rating"],
    sample_rows: [
      {
        Title: "Dune",
        Authors: "Frank Herbert",
        "Read Status": "Read",
        "Star Rating": "4.5",
      },
    ],
    suggested_mapping: {
      title: "Title",
      author: "Authors",
      isbn13: null,
      rating: "Star Rating",
      review: null,
      shelf: "Read Status",
      date_read: null,
    },
  });
});

test("POST preview rejects missing file, bad suffix, bad UTF-8, and oversize body exactly", async () => {
  const missing = await preview(
    new Request("http://test/api/import/preview", {
      method: "POST",
      body: new FormData(),
    }),
  );
  expect({ status: missing.status, body: await missing.json() }).toEqual({
    status: 422,
    body: {
      detail: [
        { type: "missing", loc: ["body", "file"], msg: "Field required", input: null },
      ],
    },
  });
  const badName = new FormData();
  badName.set("file", new File(["x"], "books.txt"));
  const suffix = await preview(
    new Request("http://test/api/import/preview", {
      method: "POST",
      body: badName,
    }),
  );
  expect({ status: suffix.status, body: await suffix.json() }).toEqual({
    status: 422,
    body: { detail: "Uploaded file must be a .csv" },
  });
  const badUtf8 = new FormData();
  badUtf8.set("file", new File([new Uint8Array([0xff])], "books.csv"));
  const encoding = await preview(
    new Request("http://test/api/import/preview", {
      method: "POST",
      body: badUtf8,
    }),
  );
  expect({ status: encoding.status, body: await encoding.json() }).toEqual({
    status: 422,
    body: { detail: "File must be UTF-8 encoded CSV." },
  });
  const large = new FormData();
  large.set(
    "file",
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "books.csv"),
  );
  const size = await preview(
    new Request("http://test/api/import/preview", {
      method: "POST",
      body: large,
    }),
  );
  expect({ status: size.status, body: await size.json() }).toEqual({
    status: 413,
    body: { detail: "Uploaded CSV exceeds the 10 MiB limit." },
  });
});
```

**Corrected 2026-08-11 against a real FastAPI `TestClient` call.** The missing-file expectation was
originally `{ detail: "Field required: file" }`, which no code path produces. A missing `file` is not an
explicit `HTTPException` — it is FastAPI's own request-validation error, so the real body is a list:

```
no file at all   status=422 body={"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required","input":null}]}
bad suffix       status=422 body={"detail":"Uploaded file must be a .csv"}
bad utf-8        status=422 body={"detail":"File must be UTF-8 encoded CSV."}
```

The other two strings were confirmed correct, as was the case-insensitive suffix check (`BOOKS.CSV`
returns 200). Note this is the **first** place in the migration where FastAPI's auto-validation shape
matters: every 422 recorded in `write-scenarios.json` so far is a `{"detail": "<string>"}` from an
explicit raise, so there is no existing Node helper for the list form. Record this case as a parity
scenario rather than hand-asserting it.

**The 413 is a deliberate Node-only addition, not parity.** Verified that Python enforces **no** upload
size limit anywhere (`grep` for `MAX_*BYTES`, `content_length`, `max_size`, `10485760` across
`mylibrary/` finds nothing). `MAX_IMPORT_BYTES` and `Uploaded CSV exceeds the 10 MiB limit.` are new
behavior introduced by Global Constraint 10 because Vercel needs a bound on an in-memory upload. Do not
try to record a parity fixture for it and do not conclude the Python side is missing something — it is
an intentional divergence, and it must be commented as such in `import-upload.ts`.

- [ ] **Step 2: Implement the shared upload helper**

Check numeric `Content-Length` before parsing. Then use `request.formData()`, validate `File`, filename, and `file.size`; strip bytes `EF BB BF`; decode with `new TextDecoder('utf-8', { fatal: true })`; translate decode failure to the exact 422. Export only `{ text, filename }`.

- [ ] **Step 3: Implement the route**

```ts
export const runtime = "nodejs";
export const POST = withApi("/api/import/preview", async (req) => {
  const { text } = await readCsvUpload(req);
  return Response.json(buildImportPreview(text));
});
```

- [ ] **Step 4: Run focused tests and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/import-export-routes.test.ts -t preview
grep -n "runtime = 'nodejs'" app/api/import/preview/route.ts
npx prettier --write lib/server/import-upload.ts app/api/import/preview/route.ts lib/server/__tests__/import-export-routes.test.ts
```

Expected: PASS. Diff ready for review.

---

## Task 5: Add transactional `POST /import`

**Files:** `frontend/app/api/import/route.ts`, `frontend/lib/server/__tests__/import-export-routes.test.ts`, parity registry/test files

- [ ] **Step 1: Write the complete real multipart route test**

```ts
test("POST import parses generic mapping and returns exact counters from one committed loop", async () => {
  const form = new FormData();
  form.set(
    "file",
    new File(
      [
        "Book Title,Writer,Stars,Status,Notes,Finished\r\nDune,Frank Herbert,4.5,Read,Excellent,01/01/2026\r\n,Nobody,5,Read,skip me,01/02/2026\r\n",
      ],
      "generic.csv",
    ),
  );
  form.set("format", "generic");
  form.set(
    "mapping",
    JSON.stringify({
      title: "Book Title",
      author: "Writer",
      rating: "Stars",
      shelf: "Status",
      review: "Notes",
      date_read: "Finished",
    }),
  );
  const res = await importRoute(
    new Request("http://test/api/import", { method: "POST", body: form }),
  );
  expect({ status: res.status, body: await res.json() }).toEqual({
    status: 200,
    body: {
      format: "generic",
      total_rows: 2,
      skipped: 1,
      inserted: 1,
      updated: 0,
      rated: 1,
    },
  });
  const [{ id: _id, ...book }] = await db.select().from(schema.books);
  expect(book).toEqual({
    userId: "local",
    goodreadsBookId: null,
    title: "Dune",
    author: "Frank Herbert",
    additionalAuthors: null,
    isbn13: null,
    exclusiveShelf: "read",
    goodreadsRating: 5,
    appRating: null,
    appReview: "Excellent",
    feedbackUpdatedAt: expect.any(String),
    dateRead: "2026-01-01",
    dateAdded: null,
    pageCount: null,
    yearPublished: null,
    source: "csv_import",
    excludeFromProfile: false,
    isFavorite: false,
  });
});
```

- [ ] **Step 2: Write complete mapping/format error tests**

Assert whole `{status, body}` objects for invalid JSON, non-object/non-string mapping, unknown auto-detection, missing generic title mapping, explicit unknown format, missing file, and oversize/encoding errors. Use the exact details from `mylibrary/api.py:519-537` and `mylibrary/importers/formats.py:207-210`, `:252-263`.

- [ ] **Step 3: Implement validation before one transaction**

```ts
export const runtime = "nodejs";
export const POST = withApi("/api/import", async (req, ctx) => {
  const { text, form } = await readCsvUpload(req, true);
  const format = String(form.get("format") ?? "auto");
  const mapping = parseMappingField(form.get("mapping"));
  const parsed = parseImport(text, format, mapping);
  const db = getDb();
  const counts = await db.transaction((tx) =>
    importRows(tx, ctx.user.userId, SOURCE_FOR[parsed.format], parsed.rows),
  );
  ctx.timer.mark("db");
  return Response.json({
    format: parsed.format,
    total_rows: parsed.totalRows,
    skipped: parsed.skipped,
    inserted: counts.inserted,
    updated: counts.updated,
    rated: counts.rated,
  });
});
```

The exact return order is intentional. Do not put parsing inside the transaction.

- [ ] **Step 4: Register both import routes in parity replay and run**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/import-export-routes.test.ts lib/server/__tests__/parity-import-export.test.ts
grep -n 'db.transaction' app/api/import/route.ts
npx prettier --write app/api/import/route.ts lib/server/__tests__/import-export-routes.test.ts lib/server/__tests__/helpers/write-parity.ts lib/server/__tests__/parity-import-export.test.ts
```

Expected: imports and their FastAPI goldens PASS. Diff ready for review.

---

## Task 6: Add byte-exact `GET /export` and prove re-importability

**Files:** `frontend/lib/server/export.ts`, `frontend/app/api/export/route.ts`, `frontend/lib/server/serialize.ts`, `frontend/lib/server/__tests__/import-export-routes.test.ts`, parity files

- [ ] **Step 1: Write the exact CSV bytes and round-trip test**

```ts
test("CSV export is byte-exact and round-trips through the canonical parser", async () => {
  await db
    .insert(schema.books)
    .values([
      {
        userId: "local",
        title: 'Comma, "Quote"\nLine',
        author: null,
        additionalAuthors: "A\rB",
        isbn13: null,
        exclusiveShelf: "read",
        goodreadsRating: 2,
        appRating: 4,
        appReview: "Review, yes",
        dateRead: "2026-01-01",
        dateAdded: null,
        pageCount: 0,
        yearPublished: 2020,
        source: "manual",
      },
    ]);
  const res = await exportRoute(
    new Request("http://test/api/export?format=csv"),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(res.headers.get("content-disposition")).toMatch(
    /^attachment; filename="mylibrary-backup-\d{8}\.csv"$/,
  );
  const bytes = await res.text();
  // NOTE (corrected 2026-08-11 against real CPython): `A\rB` is QUOTED. Minimal
  // quoting triggers on any character in the `excel` dialect's `\r\n`
  // lineterminator, so a lone CR forces quotes. Verified DictWriter output:
  //   '..."Comma, ""Quote""\nLine",,"A\rB",,read,4,"Review, yes",2026-01-01,,0,2020\r\n'
  expect(bytes).toBe(
    'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n"Comma, ""Quote""\nLine",,"A\rB",,read,4,"Review, yes",2026-01-01,,0,2020\r\n',
  );
  const parsed = parseCanonical(bytes);
  expect(parsed).toEqual({
    format: "canonical",
    totalRows: 1,
    skipped: 0,
    rows: [
      {
        title: 'Comma, "Quote"\nLine',
        author: null,
        additionalAuthors: "A\rB",
        isbn13: null,
        shelf: "read",
        rating: 4,
        review: "Review, yes",
        dateRead: "2026-01-01",
        dateAdded: null,
        pageCount: 0,
        yearPublished: 2020,
        externalId: null,
      },
    ],
  });
});
```

- [ ] **Step 2: Write the exact JSON ordering/format test**

Freeze/match the timestamp through an injected `now` helper in `exportJsonText`, never in the route contract:

```ts
expect(exportJsonText(books, signals, new Date("2026-08-10T12:34:56.123Z")))
  .toBe(`{
  "version": 1,
  "exported_at": "2026-08-10T12:34:56.123000+00:00",
  "books": [
    {
      "title": "Dune",
      "author": "Frank Herbert",
      "additional_authors": null,
      "isbn13": null,
      "shelf": "read",
      "goodreads_rating": 5,
      "app_rating": null,
      "app_review": "caf\\u00e9",
      "effective_rating": 5,
      "is_favorite": false,
      "exclude_from_profile": false,
      "date_read": "2026-01-01",
      "date_added": null,
      "page_count": 412,
      "year_published": 1965,
      "source": "goodreads"
    }
  ],
  "taste_signals": []
}`);
```

Also seed signals out of insertion selection order and assert exact ascending IDs and exact signal keys `direction,target_kind,target_book_id,snapshot,created_at`.

- [ ] **Step 3: Implement tenant-scoped ordered queries and exact serializers**

Use `where(eq(...userId, ctx.user.userId)).orderBy(asc(id))`. CSV empty values use `''`; rating uses `appRating ?? (goodreadsRating || null)`. JSON uses nulls and stored date strings. Add a Python-compatible indented JSON function next to `pyJsonDumps`; explain that existing `pyJsonDumps` is compact/`ensure_ascii=False` and cannot reproduce endpoint bytes.

- [ ] **Step 4: Return a raw attachment without changing `withApi`**

```ts
export const GET = withApi("/api/export", async (req, ctx) => {
  const format = new URL(req.url).searchParams.get("format") ?? "csv";
  if (format !== "csv" && format !== "json")
    throw new ApiError(422, "format must be 'csv' or 'json'.");
  const body = await buildExport(getDb(), ctx.user.userId, format);
  ctx.timer.mark("db");
  const stamp = utcDateStamp(new Date());
  return new Response(body, {
    headers: {
      "Content-Type":
        format === "csv" ? "text/csv; charset=utf-8" : "application/json",
      "Content-Disposition": `attachment; filename="mylibrary-backup-${stamp}.${format}"`,
    },
  });
});
```

- [ ] **Step 5: Register export and compare the real FastAPI golden bytes/headers**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/import-export-routes.test.ts lib/server/__tests__/parity-import-export.test.ts
grep -n 'Content-Disposition' app/api/export/route.ts
npx prettier --write lib/server/export.ts app/api/export/route.ts lib/server/serialize.ts lib/server/__tests__/import-export-routes.test.ts lib/server/__tests__/helpers/write-parity.ts lib/server/__tests__/parity-import-export.test.ts
```

Expected: CSV raw bytes, JSON raw text/key order, headers, invalid format, tenant isolation, and canonical round-trip all PASS.

---

## Task 7: Remove the dead HTTP ingest surface completely

**Files:** `mylibrary/api.py`, `mylibrary/ingest.py`, `frontend/lib/api.ts`, `README.md`, `docs/superpowers/plans/wave-3-verification.md`, `docs/superpowers/plans/2026-08-03-node-backend-wave-0.md`, `docs/superpowers/plans/2026-08-04-node-backend-wave-1.md`, both wave-4 inventory docs, any test/switcher file found by the proof search

- [ ] **Step 1: Remove both Python handlers and only imports made unused**

Delete the complete decorated functions at `mylibrary/api.py:435-477`: `/ingest`, `/ingest/upload`, their temp-file behavior, and unused schema/config imports. Do not delete `mylibrary/ingest.ingest_csv` or the CLI command.

- [ ] **Step 2: Remove the orphaned client method**

Delete `api.ingestUpload` and both `/ingest/upload` literals at `frontend/lib/api.ts:504-513`. Keep `previewImport`, `importLibrary`, and `exportLibrary` unchanged except where route switching naturally follows Task 8.

- [ ] **Step 3: Remove/retire every documentation reference file by file**

- `README.md`: remove live `POST /ingest` from the public endpoint list.
- `mylibrary/ingest.py`: say it is the stable CLI compatibility entry point, not HTTP.
- `wave-3-verification.md`: replace `/ingest*` remaining-route wording with the surviving `/import*` boundary.
- wave-0 and wave-1 plans: annotate historical `/ingest/upload` direct-fetch notes as removed in wave 4b rather than pretending the historical step never happened.
- both wave-4 inventories: mark the two ingest routes deleted by 4b; retain them as historical inventory evidence.
- `docs/superpowers/codex-workflow-notes.md`: update its live-surface statement because the method no longer exists.

- [ ] **Step 4: Prove no live URL, client, switcher row, or assertion survives**

```bash
cd /home/chase/Documents/Code/my-library
rg -n --glob '!docs/superpowers/plans/2026-08-10-node-backend-wave-4b-import-export.md' 'ingestUpload|@app\.post\("/ingest|baseFor\('/ingest|/ingest/upload' mylibrary frontend tests README.md CLAUDE.md docs
grep -n 'def ingest_csv' mylibrary/ingest.py
grep -n 'ingest_csv' mylibrary/cli.py
```

Expected: first search prints only explicitly retained historical inventory annotations, never executable code or a live API list; both symbol proofs print the CLI path. If a backend-switcher row or test assertion is found, remove it in this task even though the current verified inventory found none.

- [ ] **Step 5: Run targeted Python/frontend tests and format touched frontend files**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/pytest tests/test_ingest.py tests/test_import_api.py tests/test_importers.py
cd frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
npx prettier --write lib/api.ts
```

Expected: reusable CLI ingest/import tests remain green. Diff ready for review.

---

## Task 8: Flip exactly the three wave-4b routes and update project state

**Files:** `frontend/lib/backend.ts`, `frontend/lib/__tests__/backend.test.ts`, `CLAUDE.md`

- [ ] **Step 1: Change every switcher assertion first**

```ts
test("auto: wave-4b import/export routes go to Node; wave 4c stays on Python", () => {
  expect(baseFor("/import/preview", "POST")).toBe("/api");
  expect(baseFor("/import", "POST")).toBe("/api");
  expect(baseFor("/export", "GET")).toBe("/api");
  expect(baseFor("/enrich/start", "POST")).toBe(PY);
});

test("wave-4b rules are exact and method-specific", () => {
  expect(baseFor("/import/preview", "GET")).toBe(PY);
  expect(baseFor("/import/preview/child", "POST")).toBe(PY);
  expect(baseFor("/import", "GET")).toBe(PY);
  expect(baseFor("/import/child", "POST")).toBe(PY);
  expect(baseFor("/export?format=json", "GET")).toBe("/api");
  expect(baseFor("/export", "POST")).toBe(PY);
  expect(baseFor("/export/history", "GET")).toBe(PY);
});
```

Update the exact-array test name and add all three literal objects; keep all wave-4a rows and `/enrich/start -> PY` assertions.

- [ ] **Step 2: Prove Jest fails before the production list changes**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
```

Expected: FAIL on the new auto-mode and full-list assertions.

- [ ] **Step 3: Add the exact rules**

```ts
// Wave 4b: multipart import and attachment export. Exact + method-specific;
// /import is a prefix of /import/preview, so each route is independently locked.
{ prefix: '/import/preview', methods: ['POST'], exact: true },
{ prefix: '/import', methods: ['POST'], exact: true },
{ prefix: '/export', methods: ['GET'], exact: true },
```

Place them after wave 4a in both production and snapshot arrays. Query stripping at `frontend/lib/backend.ts:93-95` makes `/export?format=json` match without broadening the path.

- [ ] **Step 4: Update `CLAUDE.md` while preserving future boundaries**

Record wave 4b's three Node routes, byte-exact backup/import contract, and dead-ingest deletion. State that wave 4c enrichment remains blocked on background execution and wave 5 owns admin/Python cutover. Do not add queue architecture.

- [ ] **Step 5: Run Jest, prove exact rows, and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
grep -n "prefix: '/import/preview'" lib/backend.ts lib/__tests__/backend.test.ts
grep -n "prefix: '/import'.*methods: \['POST'\].*exact: true" lib/backend.ts lib/__tests__/backend.test.ts
grep -n "prefix: '/export'.*methods: \['GET'\].*exact: true" lib/backend.ts lib/__tests__/backend.test.ts
npx prettier --write lib/backend.ts lib/__tests__/backend.test.ts
```

Expected: PASS. Diff ready for review.

---

## Task 9: Full verification and handoff

Jest and Vitest cover disjoint paths: Jest excludes `lib/server/**` and `app/api/**`, while Vitest owns them. Neither substitutes for the other.

- [ ] **Step 1: Run all four frontend commands separately**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand
npm run test:server
npm run type-check
npm run lint
```

- [ ] **Step 2: Run the complete Python suite**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/pytest
```

- [ ] **Step 3: Check formatting only on files touched by execution**

Run `npx prettier --check <explicit touched frontend files>` from `frontend/`. Do not use `npm run format` or `prettier --write .`.

- [ ] **Step 4: Re-run the critical proof searches**

```bash
cd /home/chase/Documents/Code/my-library
grep -n 'UPDATE_ELIGIBLE_FIELDS' frontend/lib/server/import-books.ts
grep -n 'roundRatingHalfUp' frontend/lib/server/serialize.ts
grep -n 'record_delimiter.*\\r\\n' frontend/lib/server/import-csv.ts
grep -n 'Content-Disposition' frontend/app/api/export/route.ts
grep -n "runtime = 'nodejs'" frontend/app/api/import/route.ts frontend/app/api/import/preview/route.ts
rg -n 'appRating|appReview|feedbackUpdatedAt' frontend/lib/server/import-books.ts
rg -n 'ingestUpload|@app\.post\("/ingest|baseFor\('/ingest' mylibrary frontend tests README.md CLAUDE.md
```

Review the `app*` hits: inserts may set them under the locked seed rule; the update object must not. The ingest search must print nothing.

- [ ] **Step 5: Inspect the exact migration boundary**

```bash
cd /home/chase/Documents/Code/my-library
git diff --stat
git diff -- frontend/package.json frontend/lib/server/import-csv.ts frontend/lib/server/import-upload.ts frontend/lib/server/import-books.ts frontend/lib/server/export.ts frontend/app/api/import/preview/route.ts frontend/app/api/import/route.ts frontend/app/api/export/route.ts frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts mylibrary/api.py frontend/lib/api.ts
```

Confirm no enrichment/admin route, queue/worker, schema migration, or Python cutover change exists.

- [ ] **Step 6: Report for handoff**

Report the exact diff, golden-fixture regeneration, five command results, and any deviation. The diff is ready for Chase's review. Chase chooses commits, commits, merges, pushes, and deploys by hand.

---

## Done when

- Exactly `POST /import/preview`, `POST /import`, and `GET /export` reach same-origin `/api` in auto mode with exact method/path guards; enrichment stays Python.
- Multipart uploads use the explicit 10 MiB in-memory limit, Node runtime, `.csv`/fatal UTF-8/BOM validation, and real `File` handling.
- The CSV dependency edge matrix proves embedded comma, quote, newline, lone CR, short/long ragged rows, BOM, and trailing empty-line parity.
- Import reproduces all four parsers, exact counters, one transaction, tenant isolation, dedup precedence, same-batch indexing, date-only storage, and half-up star rounding.
- Whole-object tests prove existing `app_rating`, `app_review`, and `feedback_updated_at` never change; review seeding is insert-only and rating-gated.
- CSV export bytes match the FastAPI golden, use the exact canonical order/dialect/empty representation, and round-trip through the canonical parser to identical rows.
- JSON export text matches exact key order, version, Python escaping/indentation, date representation, and six-digit `+00:00` timestamp form.
- Both Python and Node parity harnesses record/replay multipart plus raw bodies and selected headers; the real FastAPI export is the golden.
- `/ingest` and `/ingest/upload` handlers, client method, switcher/test references, and live documentation references are gone while CLI `ingest_csv` remains.
- `npm test -- --runInBand`, `npm run test:server`, `npm run type-check`, `npm run lint`, and `.venv/bin/pytest` all pass; targeted Prettier check passes.
- No agent ran commit, cherry-pick, merge, push, or deploy. The diff is ready for Chase's review.

---

## Verification record — filled in 2026-08-11

**Status: implementation-complete, test-verified, AND live-verified in a browser** (2026-08-11, Claude
in Chrome, against an isolated throwaway Postgres container — never dev Supabase). See "Live browser
verification" below for what was exercised and the one item that could not be confirmed.

### The five commands, each run separately by Claude (not from an agent's self-report)

| Command | Result |
| --- | --- |
| `npm test -- --runInBand` (Jest) | 5 suites, **38/38 passed** |
| `npm run test:server` (Vitest) | **62 files, 408/408 passed** |
| `npm run type-check` | `tsc --noEmit`, **0 errors** |
| `npm run lint` | `eslint .`, **clean** |
| `.venv/bin/pytest` | **360 passed** |

`npx prettier --check` on all 18 touched frontend source files: clean. `fixtures/parity/` is
Prettier-ignored (see below).

### Proof searches (Step 4)

All as expected. `UPDATE_ELIGIBLE_FIELDS` at `import-books.ts:6`; `roundRatingHalfUp` at
`serialize.ts:65`; `record_delimiter` CRLF at `import-csv.ts:43,69`; `Content-Disposition` at
`export/route.ts:18`; `runtime = 'nodejs'` on all three routes. The `app*` grep hits
`import-books.ts:122-124` **only inside the insert path** — the update path never writes them, so
locked decision #2 holds. The ingest search prints **nothing**.

### Boundary (Step 5)

No schema, migration, `.sql`, enrichment, admin, worker, queue, or Redis change. `mylibrary/api.py` is
**0 added / 49 deleted** — pure deletion. `backend.ts` gained exactly three rules. Live routing verified
by executing `baseFor`: the three wave-4b routes and `/export?format=json` resolve to `/api`; `/enrich`,
`/enrich/start`, `/enrich/status/1`, `GET /import`, `POST /export`, `/import/child`, and
`/export/history` all still resolve to Python.

### Plan defects found and corrected during execution

Each was measured against the running interpreter or the live FastAPI app, not argued from source:

1. **CSV `\r` quoting was wrong in two places** (Task 1 fixture and Task 6's export golden). CPython's
   `excel` dialect is `QUOTE_MINIMAL`, which quotes on any character in `lineterminator` (`\r\n`), so a
   lone CR forces quotes. `csv-stringify` does not do this by default; `quoted_match: /[\r\n]/` was
   required. Fixing only the reported instance would have shipped the same defect in Task 6.
2. **`pyRound` is module-private**, so Task 1's contrast assertion could not import it. Switched to the
   already-exported `pyRoundHalfEven`, which *is* Python's one-arg `round()`.
3. **Task 3's timezone control paired `en-CA` with the `en-US` string `12/31/2025`.** Modern ICU renders
   `en-CA` as ISO-like. Now uses `en-US` with explicit numeric options so it does not depend on the
   bundled ICU version.
4. **Task 4's missing-file 422 was invented.** A missing form field is FastAPI request validation, so the
   real body is a list: `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required","input":null}]}`.
   Recorded as a parity scenario rather than hand-asserted.
5. **Task 5's error *ordering* was unstated.** Measured: bad-suffix beats bad-mapping, because
   `_decode_upload` runs before mapping parsing.
6. **Four helper-level Python divergences** found by differential-testing every normalization helper
   against its Python original over a shared input matrix: unpadded dates (`2026/1/2`), mixed separators
   (`2026/01-02`, which Node wrongly accepted), hex/binary/octal literals (`0x10` → 16 in JS, `None` in
   Python), and underscore separators (`1_000` → 1000 in Python, `null` in JS). All closed; the matrix
   now agrees except the documented item below.

### Deliberate, documented divergences from Python

- **10 MiB / 413 upload bound.** Python enforces no size limit anywhere (verified by grep for every
  spelling). This is new behavior required by Constraint 10 for serverless. It cannot be parity-tested
  and must not be deleted to "restore parity".
- **`parse_int` overflow.** Python's `parse_int` catches only `ValueError`, so `int(float("inf"))` raises
  `OverflowError` and propagates as an unhandled 500 on a malformed cell. Node returns `null`. Reproducing
  a crash is not what Constraint 2 means; commented in place so it is not "fixed" back.
- **`taste_signal.created_at` generator.** Python uses `server_default=func.now()` (database-generated);
  Node's wave-2 `/taste-signal` route supplies `utcnowTs()` (millisecond precision). Both produce a valid
  timestamp. Left alone — wave-2 code, out of scope here — but recorded for Chase.

### Harness changes worth knowing

- **`fixtures/parity/` added to `.prettierignore`.** The file already carried this exact rule and its
  rationale for `fixtures/claude/` (the generator writes `json.dumps(indent=1)`, so formatting is undone
  by the next re-record); the parity directory was simply missed. Verified all three parity fixtures were
  already non-Prettier-clean at HEAD. **This deviates from Task 2 Step 6, which instructed
  `prettier --write write-scenarios.json`** — following that literally would have produced thousands of
  churn lines reverted by the next re-record.
- **Clock-derived values in text-mode bodies are now masked.** `exported_at` masking stays strict (six
  fractional digits and `+00:00` required) because Python application code produces it. `created_at`
  masking accepts 0-6 fractional digits because the recorded value comes from SQLite's
  `CURRENT_TIMESTAMP` while the replay DB and production are Postgres. Both reject a `Z` suffix or an
  offset so a genuine format break still fails. Proven by tests crossing a UTC date boundary.
- **`export-json-with-signals` scenario added.** `seed.json` has no taste-signal table, so the original
  `export-json` golden had `"taste_signals": []` and proved nothing about signal keys, ordering, or
  `created_at`. The new multi-step scenario creates signals through the real API before exporting.

### Live browser verification (2026-08-11, Claude in Chrome)

Target was the **isolated `mylib-w3b-verify` container** (`127.0.0.1:55432/mylibrary_verify`), never dev
Supabase. Safety was confirmed before any write by checking the Node API served the container's 4 seeded
books, and the dev-server log showed `userId: "local"` on every request.

**Environment gotcha worth recording:** browsing `http://127.0.0.1:3100` silently breaks the app. Next 16
blocks cross-origin dev resources, logging `Blocked cross-origin request to Next.js dev resource
/_next/webpack-hmr from "127.0.0.1"`, which kills hydration — the page renders server-side but no click
handler fires and no client fetch happens. It looks exactly like a broken app. Use
`http://localhost:3100`. Nothing to do with wave 4b.

What was exercised end to end through the real UI, with `read_network_requests` confirming every call
went to same-origin `/api` (i.e. Node, not Python):

| Flow | Result |
| --- | --- |
| `POST /api/import/preview` | 200 — modal showed "Detected: **The StoryGraph**, 9 columns" |
| `POST /api/import` | 200 — 4 rows: 2 inserted, 1 updated, 1 skipped |
| `GET /api/export?format=csv` | 200, `text/csv; charset=utf-8`, `attachment; filename="mylibrary-backup-20260811.csv"` |
| `GET /api/export?format=json` | 200, `application/json`, matching `.json` filename |
| Round-trip re-import | 200 — canonical detected as "**MyLibrary backup**, 11 columns", 6 books in / 6 matched / **0 duplicates** |

Verified in the database afterward, not from the UI's own summary:

- **Half-up rounding is live.** `Star Rating` `4.5` → stored `goodreads_rating = 5`.
- **Insert-only review seeding is live.** The new rated row got `app_review` set and
  `feedback_updated_at` stamped, with `app_rating` left `null`. The new *unrated-review-free* row got
  neither.
- **Locked decision #2 holds against a real database.** `Dune` matched by normalized title + surname and
  its `goodreads_rating` moved 5 → 4, while `app_rating`, `app_review`, `feedback_updated_at` **and**
  `source` were untouched. A blank incoming `date_read` preserved the stored value.
- **The blank-title row was skipped** — book count went 4 → 6, with no `Nobody At All` row.
- **The effective-rating re-import quirk is live.** On round-trip, `Project Hail Mary` kept
  `app_rating = 3` and its review, while `goodreads_rating` moved 4 → 3 — i.e. the exported effective
  rating landed in `goodreads_rating`, exactly as documented.
- **Non-ASCII survives the whole loop.** `Café Extraordinaire` and `日本語の本` imported, exported, and
  re-imported without duplicating, so the UTF-8 decode and the dedup normalization both handle them.

**Gap #4 from the previous list is now closed, and closed the strongest way available.** With real
non-ASCII data in the library, Python's own `export_csv` / `json.dumps(export_json(...), indent=2)` was
run against the **same** container database and diffed against the bytes the Node route had just served:

```
===== CSV: Python vs Node  =====  BYTE-IDENTICAL
===== JSON: Python vs Node =====  BYTE-IDENTICAL   (exported_at masked — it is a clock read)
```

The live JSON contains `"Café Extraordinaire"`, `"Loved it — déjà vu"` and
`"日本語の本"`, so `ensure_ascii` escaping is now proven against Python on real
data rather than only against a hand-written expectation.

**The one thing that could not be confirmed:** no file landed on disk. Both export requests returned 200
with correct bytes and headers, and the page's `downloadBlob` path ran, but no `mylibrary-backup-*` file
appeared anywhere under `$HOME` and no `.crdownload` either. Chrome appears not to persist a
programmatic blob download triggered by automation. This is a browser-automation limitation, not
evidence of an app defect — but **"the browser saves a usable file when a human clicks Download" is still
formally unverified**, and it is the last thing worth a manual click. Note also that the saved filename
comes from the *client* (`settings/page.tsx` computes its own stamp), not from the server's
`Content-Disposition`, so the header is only what an API client would see.

Cleanup: dev server stopped, container stopped (`docker start mylib-w3b-verify` to reuse),
`frontend/next-env.d.ts` reverted after `next dev` rewrote it, and `tsc --noEmit` re-confirmed clean
afterward.

### What remains unproven — do not read the green suite as "done"

Items 1, 3 and 4 from the original list are now **closed** by the live browser pass above. What is still
outstanding:

1. **The browser actually writing a file to disk.** Exports return 200 with correct bytes and headers and
   the client download path runs, but Chrome did not persist the blob under automation. Needs one manual
   click to confirm.
2. **The 10 MiB rejection has never been exercised over a real HTTP request** — only via a constructed
   `Request` in tests. The pre-`formData()` `Content-Length` branch in particular depends on the real
   runtime setting that header, and a >10 MiB upload was not attempted in the browser.
3. **Nothing was verified against Supabase/Vercel.** All live checks ran on a local throwaway Postgres
   container under `next dev`. Serverless specifics — the `nodejs` runtime declaration mattering, request
   body size limits at the platform edge, cold-start behavior — are unexercised.
4. **A real Goodreads export was not used.** The live import used a hand-built StoryGraph CSV and the
   app's own canonical backup. The Goodreads parser (with its distinct `int(float(s))` rating rule and
   ignored `My Review`) is covered only by unit tests and fixtures, not by a real Goodreads file.
5. **Repo-wide `ruff check mylibrary/` is red** with four import-order findings in `archetype.py`,
   `db.py`, `library.py`. Confirmed pre-existing by running ruff against a `git archive` of HEAD:
   identical four findings. Not caused by this wave, and not fixed here.
