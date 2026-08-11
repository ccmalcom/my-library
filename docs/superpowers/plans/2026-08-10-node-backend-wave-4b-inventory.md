# Wave 4b read-only inventory

No files were changed.

## 1. `POST /import/preview`

### HTTP and multipart flow

The handler is `POST /import/preview`, requires the shared authenticated `UserId`, and declares one required multipart field named `file` with FastAPI’s `UploadFile = File(...)`. It performs no persistence: decode upload → extract headers → detect format → collect samples → suggest mapping → serialize `ImportPreviewOut` ([mylibrary/api.py:491](/home/chase/Documents/Code/my-library/mylibrary/api.py:491), [mylibrary/api.py:497](/home/chase/Documents/Code/my-library/mylibrary/api.py:497)).

The shared authentication dependency either resolves the caller’s ID or returns `401` with `detail=str(AuthError)`; in local mode it resolves to the local user ([mylibrary/api.py:223](/home/chase/Documents/Code/my-library/mylibrary/api.py:223), [mylibrary/api.py:234](/home/chase/Documents/Code/my-library/mylibrary/api.py:234), [mylibrary/api.py:242](/home/chase/Documents/Code/my-library/mylibrary/api.py:242)).

FastAPI handles multipart parsing and required-field validation before the handler. The repository pins `python-multipart`, which supplies multipart parsing ([requirements.txt:1](/home/chase/Documents/Code/my-library/requirements.txt:1), [requirements.txt:2](/home/chase/Documents/Code/my-library/requirements.txt:2)). A missing `file` therefore produces FastAPI’s normal `422` request-validation response rather than a route-defined detail string; the route itself contains no custom missing-file branch ([mylibrary/api.py:492](/home/chase/Documents/Code/my-library/mylibrary/api.py:492)).

### Filename and decoding

`_decode_upload`:

1. Uses `file.filename or ""`.
2. Lowercases the entire filename.
3. Requires it to end exactly in `.csv`; directories or earlier `.csv` substrings do not matter, while `.CSV` is accepted.
4. Reads the entire file synchronously through `file.file.read()`.
5. Decodes bytes as `utf-8-sig`. This accepts ordinary UTF-8 and consumes one leading UTF-8 BOM instead of exposing it in the first header.
6. It has no fallback encoding and does not persist the upload ([mylibrary/api.py:480](/home/chase/Documents/Code/my-library/mylibrary/api.py:480), [mylibrary/api.py:482](/home/chase/Documents/Code/my-library/mylibrary/api.py:482), [mylibrary/api.py:484](/home/chase/Documents/Code/my-library/mylibrary/api.py:484), [mylibrary/api.py:486](/home/chase/Documents/Code/my-library/mylibrary/api.py:486)).

Route-defined error paths are:

| Condition | Status | Exact `detail` |
|---|---:|---|
| Missing/empty filename or filename not ending in `.csv`, case-insensitively | 422 | `Uploaded file must be a .csv` |
| Bytes are not valid `utf-8-sig` | 422 | `File must be UTF-8 encoded CSV.` |
| Authentication failure | 401 | Dynamic `str(AuthError)` |

The two fixed upload errors are defined directly in `_decode_upload` ([mylibrary/api.py:482](/home/chase/Documents/Code/my-library/mylibrary/api.py:482), [mylibrary/api.py:485](/home/chase/Documents/Code/my-library/mylibrary/api.py:485)). The preview handler does not catch CSV/parser or response-validation exceptions itself ([mylibrary/api.py:497](/home/chase/Documents/Code/my-library/mylibrary/api.py:497)).

### Exact response shape

Pydantic field declaration order, which is also serialized JSON key order:

```text
format: string
headers: string[]
sample_rows: Array<Record<string, string>>
suggested_mapping: Record<string, string | null>
```

The model documents expected `format` values as `goodreads | storygraph | canonical | unknown`, but its runtime type is unrestricted `str`, not a `Literal` ([mylibrary/schemas.py:480](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:480), [mylibrary/schemas.py:483](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:483)). The frontend narrows the same shape to those four format literals and the seven `MappingField` keys ([frontend/lib/api.ts:211](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:211), [frontend/lib/api.ts:215](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:215)).

The existing API test sends a real multipart upload and verifies status `200`, StoryGraph detection, the `Title` header, and at least one sample row ([tests/test_import_api.py:16](/home/chase/Documents/Code/my-library/tests/test_import_api.py:16), [tests/test_import_api.py:25](/home/chase/Documents/Code/my-library/tests/test_import_api.py:25)).

## 2. Format detection, headers, and samples

### `detect_format` precedence

Headers are trimmed before all comparisons. Two sets are constructed:

- `hset`: trimmed but case-preserving.
- `lower`: trimmed and lowercased ([mylibrary/importers/formats.py:145](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:145)).

Rules, in exact precedence order:

| Priority | Result | Required headers | Matching |
|---:|---|---|---|
| 1 | `goodreads` | `Book Id` **and** `Exclusive Shelf` | Exact set membership after outer whitespace trimming; case-sensitive |
| 2 | `storygraph` | `Read Status` **and** `Star Rating` | Exact set membership after outer whitespace trimming; case-sensitive |
| 3 | `canonical` | `title`, `shelf`, and `rating` | Exact set membership after trimming and lowercasing; case-insensitive |
| 4 | `unknown` | Anything else | Fallback |

These rules do not require `Title`, authors, reviews, or any other columns. If a header set satisfies multiple formats, the earlier rule wins ([mylibrary/importers/formats.py:148](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:148), [mylibrary/importers/formats.py:150](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:150), [mylibrary/importers/formats.py:152](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:152), [mylibrary/importers/formats.py:154](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:154)).

The four detection outcomes are directly asserted in `test_detect_format_sniffs_headers` ([tests/test_importers.py:146](/home/chase/Documents/Code/my-library/tests/test_importers.py:146)).

### `csv_headers`

CSV reading uses Python `csv.DictReader(io.StringIO(text))` with the standard dialect defaults; no delimiter sniffing or custom dialect is supplied ([mylibrary/importers/formats.py:46](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:46)). `csv_headers` returns `list(reader.fieldnames or [])`, preserving header order and exact header text; an empty/no-header input returns `[]` ([mylibrary/importers/formats.py:51](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:51)).

### `sample_rows`

The default sample count is exactly five data rows. Enumeration starts at zero and stops before appending row index five ([mylibrary/importers/formats.py:56](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:56), [mylibrary/importers/formats.py:60](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:60)).

Each wire row is an object mapping CSV header strings to string values. Every falsey cell returned by `DictReader`, including a missing cell represented internally as `None`, is emitted as `""`; nonempty strings are unchanged ([mylibrary/importers/formats.py:57](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:57), [mylibrary/importers/formats.py:63](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:63)). No numeric, date, or boolean coercion occurs.

## 3. `suggest_mapping`

The output is initialized in this exact key order, with every value initially `None`:

```text
title, author, isbn13, rating, review, shelf, date_read
```

That order comes from `MAPPING_FIELDS`; unmatched fields remain JSON `null` ([mylibrary/importers/formats.py:30](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:30), [mylibrary/importers/formats.py:196](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:196)).

For each target field, headers are examined in input order. Each header is trimmed and lowercased. A match is a case-insensitive **substring**, not equality or token matching. The first matching header wins for that target field; the same header may independently match more than one target because fields are processed independently ([mylibrary/importers/formats.py:198](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:198), [mylibrary/importers/formats.py:200](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:200)).

Exact field/hint precedence:

| Target | Hints, checked in tuple order |
|---|---|
| `title` | `title`, `book` |
| `author` | `author`, `writer`, `by` |
| `isbn13` | `isbn` |
| `rating` | `rating`, `stars`, `star`, `score` |
| `review` | `review`, `notes`, `comment` |
| `shelf` | `shelf`, `status`, `read status`, `bookshelf` |
| `date_read` | `date read`, `read date`, `finished` |

The complete table is defined at [mylibrary/importers/formats.py:184](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:184). Because matching uses `any(...)`, hint tuple order does not choose between headers; header order does. For example, the repository test maps `Book Title`, `Writer`, `My Stars`, `Notes`, and `Status` as expected ([tests/test_importers.py:161](/home/chase/Documents/Code/my-library/tests/test_importers.py:161)).

## 4. Canonical `ImportRow` and the four parsers

### Exact `ImportRow`

Field order, Python type, and default:

| Field | Type | Default |
|---|---|---|
| `title` | `str` | Required |
| `author` | `str \| None` | `None` |
| `additional_authors` | `str \| None` | `None` |
| `isbn13` | `str \| None` | `None` |
| `shelf` | `str \| None` | `None` |
| `rating` | `int \| None` | `None` |
| `review` | `str \| None` | `None` |
| `date_read` | `date \| None` | `None` |
| `date_added` | `date \| None` | `None` |
| `page_count` | `int \| None` | `None` |
| `year_published` | `int \| None` | `None` |
| `external_id` | `str \| None` | `None` |

The authoritative declaration is [mylibrary/importers/core.py:105](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:105).

All four parsers increment `total_rows` for every `DictReader` data row, trim the title, and increment `skipped`/emit no `ImportRow` when the title is empty ([mylibrary/importers/formats.py:80](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:80), [mylibrary/importers/formats.py:120](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:120), [mylibrary/importers/formats.py:160](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:160), [mylibrary/importers/formats.py:213](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:213)).

### Goodreads

| CSV column | `ImportRow` field | Transformation |
|---|---|---|
| `Title` | `title` | Trim; blank row skipped |
| `Author` | `author` | Trim; blank → `None` |
| `Additional Authors` | `additional_authors` | Trim; blank → `None` |
| `ISBN13`, then `ISBN` | `isbn13` | `clean_isbn(ISBN13) or clean_isbn(ISBN)` |
| `Exclusive Shelf` | `shelf` | Trim only; blank → `None`; deliberately not synonym-normalized |
| `My Rating` | `rating` | `parse_int(...) or 0`, then `rating or None`; zero/blank/invalid become `None` |
| `My Review` | — | Deliberately ignored; `review=None` |
| `Date Read` | `date_read` | `parse_date` |
| `Date Added` | `date_added` | `parse_date` |
| `Number of Pages` | `page_count` | `parse_int` |
| `Original Publication Year`, then `Year Published` | `year_published` | First truthy parsed integer wins |
| `Book Id` | `external_id` | Trim; blank → `None` |

This mapping is implemented at [mylibrary/importers/formats.py:77](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:77) through [mylibrary/importers/formats.py:106](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:106). The intentional `My Review` omission preserves legacy behavior ([mylibrary/importers/formats.py:95](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:95)).

### StoryGraph

| CSV column | `ImportRow` field | Transformation |
|---|---|---|
| `Title` | `title` | Trim; blank row skipped |
| `Authors` | `author`, `additional_authors` | Replace literal `" and "` with `", "`, split on every comma, trim/drop blanks; first part is primary author; remaining parts joined with `", "` |
| `Contributors` | `additional_authors` | Trim; appended after extra authors with `", "` |
| `ISBN/UID` | `isbn13` | Clean ISBN wrapper, then accept only exactly 13 ASCII/Unicode-digit characters satisfying `str.isdigit()` |
| `Read Status` | `shelf` | `normalize_shelf` |
| `Star Rating` | `rating` | `parse_rating` |
| `Review` | `review` | Trim; blank → `None` |
| `Last Date Read` | `date_read` | `parse_date` |
| `Date Added` | `date_added` | `parse_date` |
| — | Remaining fields | Defaults |

Author splitting is defined at [mylibrary/importers/formats.py:67](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:67); ISBN/UID filtering is at [mylibrary/importers/formats.py:109](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:109); the complete parser mapping is at [mylibrary/importers/formats.py:117](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:117). Tests specifically verify half-star rounding, review/shelf mapping, a valid ISBN, blank rating, and rejection of a non-ISBN UID ([tests/test_importers.py:129](/home/chase/Documents/Code/my-library/tests/test_importers.py:129)).

### Canonical backup

| CSV column | `ImportRow` field | Transformation |
|---|---|---|
| `title` | `title` | Trim; blank row skipped |
| `author` | `author` | Trim; blank → `None` |
| `additional_authors` | `additional_authors` | Trim; blank → `None` |
| `isbn13` | `isbn13` | `clean_isbn` |
| `shelf` | `shelf` | `normalize_shelf` |
| `rating` | `rating` | `parse_rating` |
| `review` | `review` | Trim; blank → `None` |
| `date_read` | `date_read` | `parse_date` |
| `date_added` | `date_added` | `parse_date` |
| `page_count` | `page_count` | `parse_int` |
| `year_published` | `year_published` | `parse_int` |
| — | `external_id` | `None` |

The canonical column order is also the CSV export order ([mylibrary/importers/formats.py:32](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:32)). Parsing is defined at [mylibrary/importers/formats.py:157](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:157), and round-trip fields are tested at [tests/test_importers.py:153](/home/chase/Documents/Code/my-library/tests/test_importers.py:153).

### Generic with mapping

A mapping must contain a truthy `title` column name or parsing raises exactly:

```text
A 'title' column mapping is required.
```

([mylibrary/importers/formats.py:207](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:207)).

Supported mappings are limited by convention to `title`, `author`, `isbn13`, `rating`, `review`, `shelf`, and `date_read`; the parser ignores other mapping keys ([mylibrary/importers/formats.py:30](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:30), [mylibrary/importers/formats.py:220](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:220)).

| Mapping key | `ImportRow` field | Transformation |
|---|---|---|
| `title` | `title` | Fetch mapped column, trim; blank row skipped |
| `author` | `author` | Trim; blank/unmapped/missing → `None` |
| `isbn13` | `isbn13` | `clean_isbn` |
| `shelf` | `shelf` | `normalize_shelf` |
| `rating` | `rating` | `parse_rating` |
| `review` | `review` | Trim; blank → `None` |
| `date_read` | `date_read` | `parse_date` |
| — | All other `ImportRow` fields | Defaults |

The implementation is [mylibrary/importers/formats.py:207](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:207) through [mylibrary/importers/formats.py:235](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:235). Missing mapped CSV headers behave like empty cells because `row.get(col)` returns `None` ([mylibrary/importers/formats.py:220](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:220)).

## 5. Shared normalization helpers

### Goodreads Excel-escaped ISBN cleanup

`clean_isbn` is exactly:

1. `None` → `None`.
2. Trim outer whitespace.
3. If the trimmed value starts with `=`, remove exactly that first character.
4. Trim whitespace.
5. Strip all leading/trailing double-quote characters.
6. Trim whitespace again.
7. Empty result → `None`; otherwise return the remaining string.

It does not validate length, digits, checksum, hyphens, or ISBN-13 specifically ([mylibrary/importers/core.py:22](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:22)). Tests cover Excel-escaped ISBN-10/13, empty wrappers, empty strings, `None`, and ordinary ISBN text ([tests/test_ingest.py:14](/home/chase/Documents/Code/my-library/tests/test_ingest.py:14)).

### Tolerant integer parser

`parse_int` trims the input, returns `None` for `None` or blank, otherwise evaluates `int(float(s))`. Consequently decimal values truncate toward zero after float conversion, and scientific notation accepted by Python `float` is accepted. Only `ValueError` is caught; a successfully parsed non-finite float would not be converted cleanly by `int` ([mylibrary/importers/core.py:33](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:33)).

### Date parser

Accepted input formats, in order:

1. `%Y/%m/%d`
2. `%Y-%m-%d`
3. `%m/%d/%Y`

Input is trimmed. `None`, blank, or a value failing every format returns `None`; success returns a Python `datetime.date`, not a datetime or string ([mylibrary/importers/core.py:45](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:45)).

### Rating parser

`parse_rating` stringifies non-`None` input, trims it, and distinguishes all of blank, zero, and invalid as separate branches that converge to `None`:

- `None` → `None`.
- Blank after trimming → `None`.
- Non-numeric `float(...)` failure → `None`.
- Otherwise compute `int(value + 0.5)`: half-up for nonnegative inputs.
- Rounded value `<= 0` → `None`.
- Positive values are capped at `5`.

Thus `4.5 → 5`, `4.4 → 4`, `0.4 → None`, `0 → None`, and `9 → 5` ([mylibrary/importers/core.py:59](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:59), [tests/test_importers.py:45](/home/chase/Documents/Code/my-library/tests/test_importers.py:45)).

### Complete shelf synonym table

Input is trimmed and lowercased first. A key already in `VALID_SHELVES` is returned directly; otherwise the following lookup is used ([mylibrary/importers/core.py:96](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:96)):

| Input key | Canonical value |
|---|---|
| `read` | `read` |
| `currently-reading` | `currently-reading` |
| `currently reading` | `currently-reading` |
| `reading` | `currently-reading` |
| `to-read` | `to-read` |
| `to read` | `to-read` |
| `want to read` | `to-read` |
| `tbr` | `to-read` |
| `did-not-finish` | `did-not-finish` |
| `did not finish` | `did-not-finish` |
| `dnf` | `did-not-finish` |
| `abandoned` | `did-not-finish` |

This is the exhaustive literal table at [mylibrary/importers/core.py:79](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:79). Falsey input or an unknown spelling returns `None` ([mylibrary/importers/core.py:96](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:96)).

## 6. `import_rows`

### Deduplication precedence

Existing books are loaded for only the caller’s `user_id`, then indexed by:

- `goodreads_book_id`
- `isbn13`
- `(normalized title, normalized author surname)` ([mylibrary/importers/core.py:146](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:146)).

Per incoming row:

1. If `external_id is not None`, lookup uses **only** that external ID. ISBN and title/author fallback are not attempted.
2. Otherwise, a truthy ISBN is tried.
3. If ISBN found no match—or ISBN is absent—use `(normalize_title(title), surname(author))` ([mylibrary/importers/core.py:158](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:158)).

Title normalization lowercases, discards everything after the first colon, removes parenthesized text, replaces non-ASCII-alphanumeric characters with spaces, collapses whitespace, and trims. Surname is the last token of that normalized author string ([mylibrary/enrich.py:35](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:35), [mylibrary/enrich.py:45](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:45)).

New books are immediately added to all applicable in-memory indexes, so later rows in the same upload deduplicate against earlier inserts ([mylibrary/importers/core.py:203](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:203)). Same-batch external-ID deduplication is explicitly tested ([tests/test_importers.py:114](/home/chase/Documents/Code/my-library/tests/test_importers.py:114)).

### Update path

The exact update-eligible tuple, in order, is:

```text
author
additional_authors
isbn13
exclusive_shelf
date_read
date_added
page_count
year_published
goodreads_rating
```

([mylibrary/importers/core.py:121](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:121)).

Only incoming values that are not `None` are assigned. Therefore blank/unparseable sparse fields preserve existing data, but falsey non-`None` values such as `0` would be assigned if present in the incoming dictionary ([mylibrary/importers/core.py:214](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:214)). `title`, `goodreads_book_id`, `source`, `app_rating`, `app_review`, and `feedback_updated_at` are never updated by this path. Preservation of a prior imported rating when a re-import’s rating is blank is tested explicitly ([tests/test_importers.py:193](/home/chase/Documents/Code/my-library/tests/test_importers.py:193)).

### Insert path

A new `Book` receives:

- caller `user_id`
- `goodreads_book_id = external_id`
- title, author, additional authors, ISBN, shelf, dates, page count, publication year
- `goodreads_rating = row.rating or 0`
- `source = source` ([mylibrary/importers/core.py:181](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:181)).

The imported rating is always written to `goodreads_rating`, never `app_rating`. If and only if both `row.review` and `row.rating` are truthy on a fresh insert:

- `app_review = row.review`
- `app_rating = None`
- `feedback_updated_at = utcnow()`

Reviews are never seeded on updates, and an unrated row’s review is discarded ([mylibrary/importers/core.py:197](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:197)). This behavior is directly tested in `test_import_rows_inserts_and_seeds_review_with_rating` ([tests/test_importers.py:72](/home/chase/Documents/Code/my-library/tests/test_importers.py:72)).

### Counters

`import_rows` itself returns only `inserted`, `updated`, and `rated` ([mylibrary/importers/core.py:220](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:220)). `import_text` combines those with parser-level `total_rows` and `skipped` ([mylibrary/importers/formats.py:265](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:265)).

Exact increment rules:

- `total_rows`: every physical CSV data row encountered, before title validation.
- `skipped`: every row whose trimmed title is empty.
- `inserted`: every non-skipped parsed row for which dedup finds no match.
- `updated`: every non-skipped parsed row for which dedup finds a match, even if every incoming update-eligible value is `None` or identical.
- `rated`: every parsed `ImportRow` whose `rating` is truthy; skipped CSV rows never reach this loop ([mylibrary/importers/core.py:154](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:154), [mylibrary/importers/core.py:155](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:155), [mylibrary/importers/core.py:212](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:212), [mylibrary/importers/core.py:218](/home/chase/Documents/Code/my-library/mylibrary/importers/core.py:218)).

`inserted` and `updated` are mutually exclusive for one parsed row. `rated` is orthogonal, so one row can increment `rated` plus either `inserted` or `updated`. Including parser counters, every row increments `total_rows`; a blank-title row also increments `skipped`, while a valid rated insert increments `total_rows`, `rated`, and `inserted`.

## 7. `POST /import`

### Form contract

The required multipart part is `file`. Additional form fields are:

```text
format: string = "auto"
mapping: string | null = null
```

([mylibrary/api.py:507](/home/chase/Documents/Code/my-library/mylibrary/api.py:507), [mylibrary/api.py:510](/home/chase/Documents/Code/my-library/mylibrary/api.py:510)).

Effective accepted `format` values are:

- `auto`
- `generic`
- `goodreads`
- `storygraph`
- `canonical`

The parser registry contains the last three; `auto` and `generic` have dedicated branches ([mylibrary/importers/formats.py:238](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:238), [mylibrary/importers/formats.py:252](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:252)). Any other value raises `ValueError("Unknown format: {fmt}")` ([mylibrary/importers/formats.py:261](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:261)).

### Mapping parsing

A falsey/absent `mapping` is ignored. A truthy string is parsed with `json.loads`. It must decode to a JSON object where every key and every value is a string. Empty objects are valid at the HTTP layer, though generic parsing then rejects the missing title mapping ([mylibrary/api.py:520](/home/chase/Documents/Code/my-library/mylibrary/api.py:520), [mylibrary/api.py:526](/home/chase/Documents/Code/my-library/mylibrary/api.py:526)).

### Error paths

| Condition | Status | Exact `detail` |
|---|---:|---|
| Non-`.csv` filename | 422 | `Uploaded file must be a .csv` |
| Invalid UTF-8 | 422 | `File must be UTF-8 encoded CSV.` |
| `mapping` is malformed JSON | 422 | `mapping must be valid JSON.` |
| Parsed mapping is not an object, or any key/value is not a string | 422 | `mapping must be a JSON object of string keys and values.` |
| `format=auto` and detection returns unknown | 422 | `Could not detect the file format. Provide a column mapping (generic import).` |
| Generic format has no truthy title mapping | 422 | `A 'title' column mapping is required.` |
| Unsupported format, e.g. `xml` | 422 | `Unknown format: xml` |
| Missing required multipart `file` | 422 | Framework request-validation response |
| Authentication failure | 401 | Dynamic `str(AuthError)` |

Mapping errors are at [mylibrary/api.py:521](/home/chase/Documents/Code/my-library/mylibrary/api.py:521); all importer `ValueError`s are converted to `422 detail=str(e)` at [mylibrary/api.py:534](/home/chase/Documents/Code/my-library/mylibrary/api.py:534); auto-detection’s exact message is at [mylibrary/importers/formats.py:252](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:252).

### Response and source labels

Exact `ImportSummaryOut` key order and types:

```text
format: string
total_rows: integer
skipped: integer
inserted: integer
updated: integer
rated: integer
```

([mylibrary/schemas.py:489](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:489)).

Exact parser-format → stored `Book.source` map:

```text
goodreads -> goodreads_import
storygraph -> storygraph_import
canonical -> canonical_import
generic -> csv_import
```

([mylibrary/importers/formats.py:23](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:23)). `import_text` deliberately uses `parsed.format`, not necessarily the submitted `fmt`, to choose this label ([mylibrary/importers/formats.py:265](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:265)).

## 8. `GET /export`

### Query behavior

`format` defaults exactly to `csv`. Accepted values are case-sensitive `csv` and `json`. Any other value, including `CSV`, produces:

```text
HTTP 422
detail: format must be 'csv' or 'json'.
```

([mylibrary/api.py:541](/home/chase/Documents/Code/my-library/mylibrary/api.py:541), [mylibrary/api.py:561](/home/chase/Documents/Code/my-library/mylibrary/api.py:561)).

Both formats order books by ascending `Book.id`; JSON taste signals are independently ordered by ascending `TasteSignal.id` ([mylibrary/exporters.py:27](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:27), [mylibrary/exporters.py:55](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:55), [mylibrary/exporters.py:59](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:59)).

### CSV byte-level contract

Exact columns in order:

```text
title
author
additional_authors
isbn13
shelf
rating
review
date_read
date_added
page_count
year_published
```

([mylibrary/importers/formats.py:32](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:32)).

The writer is `csv.DictWriter` with no dialect overrides. Therefore it uses Python’s default `excel` dialect: comma delimiter, double-quote quote character, minimal quoting, doubled internal quotes, and `\r\n` record terminators. It writes one header record even for an empty library ([mylibrary/exporters.py:22](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:22), [mylibrary/exporters.py:25](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:25), [mylibrary/exporters.py:26](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:26)).

Per-row values:

| Column | Emitted value |
|---|---|
| `title` | Raw title |
| `author` | Raw value or `""` |
| `additional_authors` | Raw value or `""` |
| `isbn13` | Raw value or `""` |
| `shelf` | `exclusive_shelf` or `""` |
| `rating` | `effective_rating` or `""` |
| `review` | `app_review` or `""` |
| `date_read` | `date.isoformat()` or `""` |
| `date_added` | `date.isoformat()` or `""` |
| `page_count` | Integer if non-`None`, otherwise `""` |
| `year_published` | Integer if non-`None`, otherwise `""` |

([mylibrary/exporters.py:34](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:34)). `effective_rating` means `app_rating` when non-`None`, otherwise truthy `goodreads_rating`, otherwise unrated `None` ([mylibrary/db.py:109](/home/chase/Documents/Code/my-library/mylibrary/db.py:109)). The test confirms an app rating of `4` overrides an imported `5` in CSV ([tests/test_export.py:30](/home/chase/Documents/Code/my-library/tests/test_export.py:30)).

The endpoint declares:

```text
media_type: text/csv
Content-Disposition: attachment; filename="mylibrary-backup-YYYYMMDD.csv"
```

The date is current UTC formatted `%Y%m%d` ([mylibrary/api.py:544](/home/chase/Documents/Code/my-library/mylibrary/api.py:544), [mylibrary/api.py:545](/home/chase/Documents/Code/my-library/mylibrary/api.py:545)). FastAPI/Starlette may append its charset parameter to the actual `Content-Type`; the existing test intentionally asserts that it starts with `text/csv` ([tests/test_export.py:63](/home/chase/Documents/Code/my-library/tests/test_export.py:63)).

### JSON byte-level contract

The endpoint serializes with `json.dumps(export_json(...), indent=2)`: two-space indentation, normal Python JSON separators/escaping, insertion-order keys, and no explicitly added terminal newline ([mylibrary/api.py:553](/home/chase/Documents/Code/my-library/mylibrary/api.py:553)).

Top-level keys in exact order:

1. `version`
2. `exported_at`
3. `books`
4. `taste_signals`

`version` is integer `1`. `exported_at` is `datetime.now(timezone.utc).isoformat()`, producing an ISO-8601 UTC offset such as `2026-08-10T12:34:56.123456+00:00`; Python omits fractional seconds only if the microsecond component is zero ([mylibrary/exporters.py:65](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:65)).

Each book object has this exact key order:

```text
title
author
additional_authors
isbn13
shelf
goodreads_rating
app_rating
app_review
effective_rating
is_favorite
exclude_from_profile
date_read
date_added
page_count
year_published
source
```

([mylibrary/exporters.py:68](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:68)). Optional values remain JSON `null`; dates use `.isoformat()` ([mylibrary/exporters.py:18](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:18)).

Each `taste_signals` object has:

```text
direction
target_kind
target_book_id
snapshot
created_at
```

Optional values remain `null`; `snapshot` is emitted as stored JSON; `created_at` uses `.isoformat()` ([mylibrary/exporters.py:89](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:89)).

JSON response headers are:

```text
Content-Type: application/json
Content-Disposition: attachment; filename="mylibrary-backup-YYYYMMDD.json"
```

([mylibrary/api.py:553](/home/chase/Documents/Code/my-library/mylibrary/api.py:553), [mylibrary/api.py:558](/home/chase/Documents/Code/my-library/mylibrary/api.py:558)).

## 9. Node-side precedent

`POST /books` is the correct already-ported non-Claude body-and-database-write precedent.

### Files and layering

1. Route handler: [frontend/app/api/books/route.ts:52](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:52)
   - Zod input schema.
   - JSON parsing and validation.
   - Domain validation/normalization.
   - User-scoped dedup query.
   - Transaction and response construction.
2. Shared HTTP/auth/error wrapper: [frontend/lib/server/http.ts:35](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:35)
   - Authenticates.
   - Supplies `ctx.user.userId`, timer, params, and debug state.
   - Converts `ApiError` to FastAPI-shaped errors.
   - Converts unhandled exceptions to `500 {"detail":"Internal Server Error"}`.
3. Database access and test seam: [frontend/lib/server/db.ts:8](/home/chase/Documents/Code/my-library/frontend/lib/server/db.ts:8)
   - Drizzle/postgres-js.
   - `getDb()`.
   - `_setDbForTests(...)`.
4. Drizzle schema: [frontend/lib/server/schema.ts:48](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:48).
5. Book response/constant helpers: [frontend/lib/server/books.ts:7](/home/chase/Documents/Code/my-library/frontend/lib/server/books.ts:7).
6. Dedup helpers: imported and used by the route at [frontend/app/api/books/route.ts:7](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:7) and [frontend/app/api/books/route.ts:97](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:97).
7. Serialization helpers: imported at [frontend/app/api/books/route.ts:6](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:6).
8. Recorded write fixture: [frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json).
9. Replay registry/runner: [frontend/lib/server/__tests__/helpers/write-parity.ts:9](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/write-parity.ts:9).
10. Parity test registration: [frontend/lib/server/__tests__/parity-writes-books.test.ts:11](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/parity-writes-books.test.ts:11).
11. PGlite database fixture: [frontend/lib/server/__tests__/helpers/pglite.ts:6](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/pglite.ts:6).

Validation is route-local Zod: `req.json().catch(() => null)`, `safeParse`, then a `422` `ApiError` using the first Zod issue. Domain-specific checks follow in Python parity order ([frontend/app/api/books/route.ts:66](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:66), [frontend/app/api/books/route.ts:74](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:74)).

The transaction wrapper sits **after** validation and the read-only duplicate scan, and wraps only the book insert plus optional enrichment insert ([frontend/app/api/books/route.ts:90](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:90), [frontend/app/api/books/route.ts:103](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:103), [frontend/app/api/books/route.ts:140](/home/chase/Documents/Code/my-library/frontend/app/api/books/route.ts:140)).

### Existing multipart/attachment precedent

No existing Next route handler calls `request.formData()`, accepts `multipart/form-data`, or reads a `File`. The only multipart code is browser-side API-client code for ingest/import uploads ([frontend/lib/api.ts:504](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:504), [frontend/lib/api.ts:520](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:520), [frontend/lib/api.ts:533](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:533)).

No existing Next route returns an attachment or sets `Content-Disposition`. Existing route handlers return JSON, rate-limit JSON responses, or one empty `204`; the empty non-JSON precedent is not an attachment ([frontend/app/api/feedback/dismiss/route.ts:23](/home/chase/Documents/Code/my-library/frontend/app/api/feedback/dismiss/route.ts:23)).

## 10. Non-Claude parity harness

### Recording and fixture locations

The recorder is [scripts/gen_parity_fixtures.py:1](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:1), run from repository root as:

```bash
python scripts/gen_parity_fixtures.py
```

Its output directory is [frontend/lib/server/__tests__/fixtures/parity](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/fixtures/parity):

- `seed.json`
- `python-responses.json`
- `write-scenarios.json`

The script isolates FastAPI against a temporary SQLite database and clears hosted/network configuration before importing the application ([scripts/gen_parity_fixtures.py:28](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:28), [scripts/gen_parity_fixtures.py:47](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:47)). It records empty and seeded GET responses, then resets the database per write scenario ([scripts/gen_parity_fixtures.py:419](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:419), [scripts/gen_parity_fixtures.py:432](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:432)).

### Replay mechanics and worked example

For read parity, `checkParity`:

1. Looks up `stage` plus exact request key in `python-responses.json`.
2. Creates a fresh PGlite database.
3. Loads `seed.json` for the seeded stage.
4. Injects it through `_setDbForTests`.
5. Constructs a `Request`.
6. invokes the imported handler directly.
7. compares status and parsed JSON body.
8. closes and clears the test DB ([frontend/lib/server/__tests__/helpers/parity.ts:63](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/parity.ts:63)).

A complete worked example is [frontend/lib/server/__tests__/parity-books.test.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/parity-books.test.ts:1): it imports the real `GET` handler and replays four request keys in both empty and seeded stages.

Write parity resolves each fixture step through a method/path regex registry, constructs a JSON request, invokes the handler, and compares status and body after masking volatile values ([frontend/lib/server/__tests__/helpers/write-parity.ts:35](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/write-parity.ts:35), [frontend/lib/server/__tests__/helpers/write-parity.ts:95](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/write-parity.ts:95)).

### Harness gaps for wave 4b

The recorder currently sends only `json=step.get("json")` for write scenarios and always calls `r.json()` for nonempty responses. It cannot currently describe or record a multipart request, and it cannot preserve a non-JSON response body as bytes/text with attachment headers ([scripts/gen_parity_fixtures.py:399](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:399), [scripts/gen_parity_fixtures.py:405](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:405), [scripts/gen_parity_fixtures.py:407](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:407)). That is a concrete harness gap for both imports and export.

The Node replay helpers likewise assume JSON bodies: `runScenario` sends JSON and calls `res.json()` ([frontend/lib/server/__tests__/helpers/write-parity.ts:106](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/write-parity.ts:106), [frontend/lib/server/__tests__/helpers/write-parity.ts:114](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/write-parity.ts:114)).

### Exact frontend npm scripts

From [frontend/package.json:5](/home/chase/Documents/Code/my-library/frontend/package.json:5):

```text
npm test                 -> jest
npm run test:server      -> vitest run
npm run type-check       -> tsc --noEmit
npm run lint             -> eslint .
npm run lint:fix         -> eslint . --fix
npm run format           -> prettier --write .
npm run format:check     -> prettier --check .
```

Vitest includes `lib/server/**/*.test.ts` and `app/api/**/*.test.ts`; Jest explicitly excludes those server/API paths ([frontend/vitest.config.ts:4](/home/chase/Documents/Code/my-library/frontend/vitest.config.ts:4), [frontend/jest.config.js:4](/home/chase/Documents/Code/my-library/frontend/jest.config.js:4)).

## 11. Dead-ingest removal surface

Complete literal `/ingest` and `/ingest/upload` reference inventory, excluding generated dependency/build metadata:

### Executable Python

- `POST /ingest` handler: [mylibrary/api.py:435](/home/chase/Documents/Code/my-library/mylibrary/api.py:435).
- `POST /ingest/upload` handler: [mylibrary/api.py:444](/home/chase/Documents/Code/my-library/mylibrary/api.py:444).
- Compatibility-module docstring naming `POST /ingest[/upload]`: [mylibrary/ingest.py:3](/home/chase/Documents/Code/my-library/mylibrary/ingest.py:3).

The CLI’s `ingest` command uses `mylibrary.ingest.ingest_csv`, but it is not an HTTP-route reference and remains independently defined at [mylibrary/cli.py:44](/home/chase/Documents/Code/my-library/mylibrary/cli.py:44).

### Frontend

- `api.ingestUpload` method and both occurrences of `/ingest/upload`: [frontend/lib/api.ts:504](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:504). Repository search finds no caller of `ingestUpload` outside this method, so removing it does not leave a current UI call site.

There is no ingest-specific row in `NODE_DEFAULT_ROUTES`: unmatched paths default to Python by the switcher’s algorithm ([frontend/lib/backend.ts:85](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:85)).

### Tests

No test asserts either HTTP URL. `tests/test_ingest.py` exercises the reusable `ingest_csv` compatibility function and ISBN helper, covering ISBN cleanup, counts, idempotency, zero-rating behavior, field loading, and app-rating preservation ([tests/test_ingest.py:14](/home/chase/Documents/Code/my-library/tests/test_ingest.py:14), [tests/test_ingest.py:23](/home/chase/Documents/Code/my-library/tests/test_ingest.py:23), [tests/test_ingest.py:32](/home/chase/Documents/Code/my-library/tests/test_ingest.py:32), [tests/test_ingest.py:41](/home/chase/Documents/Code/my-library/tests/test_ingest.py:41), [tests/test_ingest.py:50](/home/chase/Documents/Code/my-library/tests/test_ingest.py:50), [tests/test_ingest.py:58](/home/chase/Documents/Code/my-library/tests/test_ingest.py:58)).

### Documentation references

- Public API list: [README.md:79](/home/chase/Documents/Code/my-library/README.md:79).
- Wave-3 verification’s remaining-route glob `/ingest*`: [docs/superpowers/plans/wave-3-verification.md:82](/home/chase/Documents/Code/my-library/docs/superpowers/plans/wave-3-verification.md:82).
- Wave-0 direct-fetch migration note: [docs/superpowers/plans/2026-08-03-node-backend-wave-0.md:2072](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-03-node-backend-wave-0.md:2072).
- Wave-1 direct-fetch migration note: [docs/superpowers/plans/2026-08-04-node-backend-wave-1.md:2078](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-04-node-backend-wave-1.md:2078).
- Previous wave-4 inventory scope/table: [docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:3](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:3), [docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:15](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:15).
- Previous inventory’s upload discussion: [docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:102](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:102).
- Previous inventory’s missing-Node-route list: [docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:389](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md:389).

## 12. Backend switcher changes

The three required additions should be separate exact, method-specific rules because `/import` is a prefix of `/import/preview` and the wave is explicitly limited to these methods/paths:

```text
{ prefix: '/import/preview', methods: ['POST'], exact: true }
{ prefix: '/import', methods: ['POST'], exact: true }
{ prefix: '/export', methods: ['GET'], exact: true }
```

The switcher supports method filtering and exact-path matching directly; query strings are removed before matching ([frontend/lib/backend.ts:12](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:12), [frontend/lib/backend.ts:92](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:92)). `exact: true` still allows `/export?format=json` because matching uses `path.split('?')[0]` ([frontend/lib/backend.ts:93](/home/chase/Documents/Code/my-library/frontend/lib/backend.ts:93)).

Assertions requiring update in [frontend/lib/__tests__/backend.test.ts](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts):

1. Rename/update the wave-4a test description at line 46.
2. Change `/export GET` from `PY` to `/api` at line 50.
3. Change `/import POST` from `PY` to `/api` at line 51.
4. Add an explicit `/import/preview POST -> /api` assertion; none currently exists.
5. Keep `/enrich/start POST -> PY` unchanged at line 52.
6. Update the exact-list test name at line 74.
7. Insert all three new rule objects into the exact `NODE_DEFAULT_ROUTES` expected array at lines 75–98.
8. The forced-node `/import` assertion at line 65 remains valid but does not prove auto-mode behavior.
9. Add method/path guards if preserving exact semantics explicitly: e.g. wrong methods or `/import/...` siblings should remain Python. Existing tests already use this style for `/profile` and `/recommend` exactness ([frontend/lib/__tests__/backend.test.ts:108](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:108), [frontend/lib/__tests__/backend.test.ts:130](/home/chase/Documents/Code/my-library/frontend/lib/__tests__/backend.test.ts:130)).

## 13. Python behavioral tests to port

### `tests/test_import_api.py`

- `test_preview_detects_storygraph`: multipart preview returns `200`, detects StoryGraph, includes `Title`, and includes sample rows ([tests/test_import_api.py:25](/home/chase/Documents/Code/my-library/tests/test_import_api.py:25)).
- `test_preview_unknown_suggests_mapping`: generic CSV detects as `unknown` and suggests `Book Title` for title ([tests/test_import_api.py:34](/home/chase/Documents/Code/my-library/tests/test_import_api.py:34)).
- `test_import_storygraph_auto`: auto-import returns `200`, inserts four books, and database count becomes four ([tests/test_import_api.py:41](/home/chase/Documents/Code/my-library/tests/test_import_api.py:41)).
- `test_import_generic_with_mapping`: JSON-string mapping plus `format=generic` returns `200` and inserts two books ([tests/test_import_api.py:49](/home/chase/Documents/Code/my-library/tests/test_import_api.py:49)).
- `test_cli_import_storygraph`: CLI-only; auto-import exits successfully and inserts four books ([tests/test_import_api.py:58](/home/chase/Documents/Code/my-library/tests/test_import_api.py:58)).

### `tests/test_importers.py`

- `test_parse_goodreads_matches_legacy_counts`: Goodreads format/counts, cleaned ISBN, external ID, and source label ([tests/test_importers.py:32](/home/chase/Documents/Code/my-library/tests/test_importers.py:32)).
- `test_parse_rating_rounds_half_up_and_clamps`: exact rating normalization cases ([tests/test_importers.py:45](/home/chase/Documents/Code/my-library/tests/test_importers.py:45)).
- `test_normalize_shelf_maps_synonyms`: canonical and synonym shelf mappings plus invalid/blank handling ([tests/test_importers.py:56](/home/chase/Documents/Code/my-library/tests/test_importers.py:56)).
- `test_clean_isbn_reused`: Excel wrapper cleanup and empty handling ([tests/test_importers.py:67](/home/chase/Documents/Code/my-library/tests/test_importers.py:67)).
- `test_import_rows_inserts_and_seeds_review_with_rating`: insert/rated counters, imported rating slot, conditional review seeding, and source ([tests/test_importers.py:72](/home/chase/Documents/Code/my-library/tests/test_importers.py:72)).
- `test_import_rows_dedups_by_title_surname_and_preserves_app_rating`: title/surname dedup, update count, app-rating preservation, shelf update ([tests/test_importers.py:91](/home/chase/Documents/Code/my-library/tests/test_importers.py:91)).
- `test_import_rows_dedups_by_isbn`: ISBN dedup despite changed title ([tests/test_importers.py:106](/home/chase/Documents/Code/my-library/tests/test_importers.py:106)).
- `test_import_rows_dedups_duplicate_external_id_within_batch`: same-file external-ID dedup and second-row update ([tests/test_importers.py:114](/home/chase/Documents/Code/my-library/tests/test_importers.py:114)).
- `test_parse_storygraph_maps_fields`: StoryGraph field mapping, half-stars, review, shelf, ISBN/UID rules ([tests/test_importers.py:129](/home/chase/Documents/Code/my-library/tests/test_importers.py:129)).
- `test_detect_format_sniffs_headers`: all four detection outcomes ([tests/test_importers.py:146](/home/chase/Documents/Code/my-library/tests/test_importers.py:146)).
- `test_parse_canonical_roundtrip_fields`: canonical format/count and representative fields ([tests/test_importers.py:153](/home/chase/Documents/Code/my-library/tests/test_importers.py:153)).
- `test_suggest_mapping_guesses_headers`: title/rating/review/shelf suggestions ([tests/test_importers.py:161](/home/chase/Documents/Code/my-library/tests/test_importers.py:161)).
- `test_parse_generic_with_mapping`: generic count, rating, and shelf normalization ([tests/test_importers.py:169](/home/chase/Documents/Code/my-library/tests/test_importers.py:169)).
- `test_import_text_auto_detects_and_imports`: automatic StoryGraph detection and four inserts ([tests/test_importers.py:181](/home/chase/Documents/Code/my-library/tests/test_importers.py:181)).
- `test_import_text_unknown_without_mapping_raises`: unknown auto-detection raises `ValueError` ([tests/test_importers.py:187](/home/chase/Documents/Code/my-library/tests/test_importers.py:187)).
- `test_reimport_with_blanked_rating_preserves_goodreads_rating`: sparse update does not erase prior rating ([tests/test_importers.py:193](/home/chase/Documents/Code/my-library/tests/test_importers.py:193)).

### `tests/test_export.py`

- `test_export_csv_has_canonical_header_and_effective_values`: canonical header presence, effective app rating, and app review ([tests/test_export.py:30](/home/chase/Documents/Code/my-library/tests/test_export.py:30)).
- `test_export_json_includes_books_and_taste_signals`: version, book inclusion, taste signal, app fields, favorite boolean ([tests/test_export.py:40](/home/chase/Documents/Code/my-library/tests/test_export.py:40)).
- `test_csv_export_roundtrips_through_import`: exported canonical CSV recreates books and effective rating through `goodreads_rating` ([tests/test_export.py:52](/home/chase/Documents/Code/my-library/tests/test_export.py:52)).
- `test_export_endpoint_csv_download`: CSV `200`, attachment header, CSV media type, header text; JSON `200` and version `1` ([tests/test_export.py:63](/home/chase/Documents/Code/my-library/tests/test_export.py:63)).
- `test_export_endpoint_rejects_bad_format`: `format=xml` returns `422` ([tests/test_export.py:81](/home/chase/Documents/Code/my-library/tests/test_export.py:81)).
- `test_cli_export_writes_file`: CLI-only; CSV export writes the requested file with canonical headers ([tests/test_export.py:90](/home/chase/Documents/Code/my-library/tests/test_export.py:90)).

## 14. Missing Node infrastructure/dependencies

The following have no existing Node equivalent in this repository:

- Multipart route-handler parsing and `File` validation. Browser-side `FormData` construction exists, but no server handler consumes it ([frontend/lib/api.ts:520](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:520)).
- CSV parsing equivalent to Python `csv.DictReader`, including quoted fields, embedded delimiters/newlines, missing cells, header preservation, and Python-compatible row semantics ([mylibrary/importers/formats.py:46](/home/chase/Documents/Code/my-library/mylibrary/importers/formats.py:46)).
- CSV writing equivalent to Python’s default `excel` dialect and its exact quoting/`\r\n` behavior ([mylibrary/exporters.py:25](/home/chase/Documents/Code/my-library/mylibrary/exporters.py:25)).
- Attachment responses with `Content-Disposition`.
- Parity-fixture support for multipart requests, raw response bodies, and response headers ([scripts/gen_parity_fixtures.py:399](/home/chase/Documents/Code/my-library/scripts/gen_parity_fixtures.py:399)).
- TypeScript ports of the import parsers, normalization functions, and import upsert logic; the current server library has book serialization/edit helpers, not import logic ([frontend/lib/server/books.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/books.ts:1)).
- Export-specific serialization of full book backups and taste signals.

`frontend/package.json` contains no CSV parsing or CSV writing dependency. Existing relevant dependencies are platform/validation/database pieces—Next, Zod, Drizzle, postgres-js—and test-only PGlite ([frontend/package.json:17](/home/chase/Documents/Code/my-library/frontend/package.json:17), [frontend/package.json:30](/home/chase/Documents/Code/my-library/frontend/package.json:30), [frontend/package.json:33](/home/chase/Documents/Code/my-library/frontend/package.json:33)). Therefore any third-party CSV parser/writer would be a new dependency; alternatively, matching Python’s CSV byte behavior without one would be new custom infrastructure.

Codex session ID: 019feee0-c05b-7880-bcec-304764eb3aac
Resume in Codex: codex resume 019feee0-c05b-7880-bcec-304764eb3aac
