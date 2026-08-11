# Wave 4c-1 synchronous enrichment inventory

Scope is limited to `enrich_library()` and the existing synchronous `POST /enrich`. Background-job machinery is intentionally excluded.

## 1. `enrich_library()` end to end

### Signature and defaults

```python
enrich_library(
    *,
    force=False,
    limit=None,
    include_unrated=False,
    retry_unresolved=False,
    requests_per_second=None,
    progress=None,
    user_id=LOCAL_USER_ID,
) -> dict
```

The exact signature and defaults are in [mylibrary/enrich.py:180](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:180).

### Initialization

Each invocation:

1. Calls `init_db()`.
2. If `requests_per_second is not None`, calls `catalog.set_rate(requests_per_second)`.
3. Calls `catalog.reset_stats()`.
4. Initializes the summary counters.

See [mylibrary/enrich.py:203](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:203).

`set_rate()` converts positive requests/second to a delay of `1 / requests_per_second`; zero or a negative value disables throttling by setting the delay to `0.0` [mylibrary/catalog.py:40](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:40).

### Exact selection behavior

The database query itself is:

```python
session.query(Book).filter(Book.user_id == user_id).all()
```

It fetches every book belonging to the supplied user [mylibrary/enrich.py:217](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:217).

There is no `ORDER BY`, so neither the SQL query nor `enrich_library()` guarantees book order. The subsequent Python lists preserve whatever order `.all()` returned [mylibrary/enrich.py:217](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:217).

Eligibility is then filtered in Python:

```python
include_unrated or b.effective_rating is not None
```

[mylibrary/enrich.py:219](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:219).

`effective_rating` is:

- `app_rating` whenever `app_rating is not None`, including zero.
- Otherwise `goodreads_rating or None`; therefore a Goodreads rating of zero is treated as unrated.

See [mylibrary/db.py:109](/home/chase/Documents/Code/my-library/mylibrary/db.py:109).

Consequently:

- `include_unrated=False`: only books whose `effective_rating` is non-`None`.
- `include_unrated=True`: every user-owned book, regardless of rating.

For each eligible candidate, `_needs_work()` returns true when:

- `force=True`; or
- the book has no `Enrichment` relationship row; or
- `retry_unresolved=True` and the existing row has `resolved_source is None`.

Otherwise it returns false [mylibrary/enrich.py:227](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:227).

The effects of the flags are therefore:

- `force=False`: any existing enrichment row is skipped unless the `retry_unresolved` condition applies.
- `force=True`: every eligible book is processed, regardless of an existing row or its resolution state.
- `retry_unresolved=False`: an existing row is skipped even if it represents an unresolved attempt.
- `retry_unresolved=True`: an existing row is retried only when its `resolved_source` is exactly `None`; confidence label, confidence value, or `match_method` do not determine retry eligibility.
- `limit`: applied only after eligible existing rows have been removed from `work`, using `work[:limit]` [mylibrary/enrich.py:234](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:234). It does not constrain the initial database query and does not constrain the skipped-existing count.

There is no validation inside `enrich_library()` for negative limits. Python slicing therefore gives ordinary slice semantics; for example, `-1` means “all work items except the last” [mylibrary/enrich.py:237](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:237).

### Totals and skipped rows

Before applying `limit`:

```python
skipped = len(candidates) - len(work)
summary["skipped_existing"] = skipped
```

After applying `limit`:

```python
full_total = skipped + len(work)
summary["total"] = full_total
```

See [mylibrary/enrich.py:234](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:234).

This has two precise consequences:

- Eligible new/retry rows excluded by `limit` are not included in `total`.
- All skipped existing rows are included in `total`, even if their count is larger than the requested limit.

### Per-book control flow

For each item in `work`, in the inherited unspecified database order:

1. `_resolve_one(book)` returns `(candidate, label, method)` [mylibrary/enrich.py:248](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:248).
2. The current relationship row is read from `book.enrichment`.
3. If absent, a new `Enrichment(book_id=book.id)` is constructed and added to the session [mylibrary/enrich.py:250](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:250).
4. If no candidate was resolved:
   - `confidence_label = "LOW"`
   - `resolution_confidence = 0.0`
   - `match_method = method`, which is `"unresolved"`
   - `resolved_at = utcnow()`
   - increment `summary["unresolved"]`
   - replace the callback-facing local label with `"unresolved"`

   See [mylibrary/enrich.py:255](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:255).

5. If a candidate exists:
   - `_apply()` writes its enrichment fields.
   - Increment the counter named by its resolution label: `HIGH`, `MEDIUM`, or `LOW`.

   See [mylibrary/enrich.py:262](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:262).

6. Increment `processed`.
7. Commit immediately for that book.
8. Fire the per-book progress callback, if supplied.

See [mylibrary/enrich.py:266](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:266).

Because the commit happens once per book, an interruption preserves already completed books rather than rolling back the entire invocation [mylibrary/enrich.py:267](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:267).

### Exact returned summary

The base object has these keys:

```json
{
  "total": 0,
  "processed": 0,
  "HIGH": 0,
  "MEDIUM": 0,
  "LOW": 0,
  "unresolved": 0,
  "skipped_existing": 0
}
```

[mylibrary/enrich.py:207](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:207).

Their exact meanings are:

| Key | Increment/assignment condition |
|---|---|
| `total` | Assigned once to `skipped_existing + len(limit-truncated work)` [mylibrary/enrich.py:239](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:239). |
| `processed` | Incremented once after every attempted work item, resolved or unresolved [mylibrary/enrich.py:266](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:266). |
| `HIGH` | Incremented when `_resolve_one()` returned an ISBN candidate from either catalog with label `HIGH` [mylibrary/enrich.py:153](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:153), [mylibrary/enrich.py:264](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:264). |
| `MEDIUM` | Incremented for a search candidate satisfying the complete medium-confidence rule below [mylibrary/enrich.py:118](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:118), [mylibrary/enrich.py:264](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:264). |
| `LOW` | Incremented when at least one search catalog supplied a candidate but no catalog produced a medium candidate, and the retained fallback candidate is labeled `LOW` [mylibrary/enrich.py:172](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:172). |
| `unresolved` | Incremented only when both ISBN attempts, Open Library search, and Google Books search produce no retained candidate [mylibrary/enrich.py:151](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:151), [mylibrary/enrich.py:255](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:255). |
| `skipped_existing` | Assigned to eligible candidate count minus pre-limit work count [mylibrary/enrich.py:234](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:234). |

After processing, an eighth key, `http`, is added from `catalog.get_stats()` [mylibrary/enrich.py:273](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:273).

No counter is incremented for rows excluded as unrated or omitted by `limit`.

---

## 2. Exact single-book resolution decision tree

The decision tree is implemented by `_resolve_one()` [mylibrary/enrich.py:151](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:151).

```text
Does book.isbn13 have a truthy value?
│
├─ Yes: catalog.openlibrary_by_isbn(isbn13)
│  ├─ returns truthy record
│  │  └─ return it immediately as HIGH, "isbn:openlibrary"
│  └─ returns None/falsy
│     └─ catalog.googlebooks_by_isbn(isbn13)
│        ├─ returns truthy record
│        │  └─ return it immediately as HIGH, "isbn:googlebooks"
│        └─ returns None/falsy
│           └─ continue to search
│
└─ No: continue directly to search
   │
   ├─ search_title = _search_title(book.title)
   ├─ catalog.openlibrary_search(search_title, book.author)
   ├─ _score_candidates(book, OL results)
   │  ├─ candidate exists and label == MEDIUM
   │  │  └─ return immediately as MEDIUM, "search:openlibrary"
   │  └─ otherwise retain OL candidate, if any, for later LOW fallback
   │
   ├─ catalog.googlebooks_search(search_title, book.author)
   ├─ _score_candidates(book, Google results)
   │  ├─ candidate exists and label == MEDIUM
   │  │  └─ return immediately as MEDIUM, "search:googlebooks"
   │  └─ otherwise retain Google candidate, if any
   │
   ├─ retained OL candidate exists
   │  └─ return OL candidate as LOW, "search:openlibrary"
   ├─ otherwise retained Google candidate exists
   │  └─ return Google candidate as LOW, "search:googlebooks"
   └─ neither search returned any candidate
      └─ return None, NONE, "unresolved"
```

The exact ordering and returns are visible at [mylibrary/enrich.py:153](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:153).

Important implications:

- An Open Library ISBN result is accepted immediately. Its title and author are not compared with the input book [mylibrary/enrich.py:153](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:153).
- A Google ISBN result is likewise accepted immediately. `googlebooks_by_isbn()` merely returns the first result from `_google_books_query("isbn:<isbn>")`; it does not verify that the returned item contains the requested ISBN [mylibrary/catalog.py:375](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:375), [mylibrary/catalog.py:384](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:384).
- Google search is still attempted after an Open Library LOW result. A Google MEDIUM result supersedes that Open Library LOW result [mylibrary/enrich.py:162](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:162).
- If both search catalogs yield only LOW candidates, Open Library always wins, even if the Google candidate has a higher title similarity. The candidates are scored only within each catalog’s result list; there is no cross-catalog comparison [mylibrary/enrich.py:172](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:172).
- A book is unresolved only if:
  - it has no truthy ISBN or both ISBN functions fail to return a candidate; and
  - `openlibrary_search()` yields no candidates; and
  - `googlebooks_search()` yields no candidates.

  Any search candidate at all becomes at least a LOW guess [mylibrary/enrich.py:172](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:172).

### Search-query preprocessing

`_search_title()`:

1. Replaces every shortest parenthesized segment matching `\(.*?\)` with an empty string.
2. Collapses runs of whitespace to one space.
3. Strips leading and trailing whitespace.
4. Preserves letter case and subtitles.

See [mylibrary/enrich.py:82](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:82).

Open Library enrichment search sends:

- `title=<cleaned title>`
- `limit=5`
- `author=<original book author>` only if the author is truthy.

It returns at most the first five `docs` [mylibrary/catalog.py:301](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:301).

Google enrichment search constructs:

```text
intitle:"<cleaned title>"
```

and, if the author is truthy, appends:

```text
 inauthor:"<original author>"
```

It uses the Google helper’s default of five results [mylibrary/catalog.py:336](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:336), [mylibrary/catalog.py:389](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:389).

---

## 3. Confidence scoring and `match_method`

### Numeric values

The stored confidence mapping is:

- `HIGH` → `0.95`
- `MEDIUM` → `0.70`
- `LOW` → `0.30`
- internal `NONE` → `0.0`

[mylibrary/enrich.py:29](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:29).

The similarity thresholds are:

- strong: `0.85`
- weak: `0.60`

[mylibrary/enrich.py:31](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:31).

### Exact title normalization

For scoring, `_normalize_title(value)`:

1. Returns `""` for a falsy input.
2. Lowercases the string.
3. Splits on `:` and keeps only the first segment.
4. Removes every shortest parenthesized segment matching `\(.*?\)`.
5. Replaces every character outside ASCII lowercase `a-z`, digits `0-9`, and literal space with a space.
6. Collapses whitespace runs.
7. Strips leading/trailing whitespace.

See [mylibrary/enrich.py:35](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:35).

Title similarity is exactly:

```python
SequenceMatcher(
    None,
    _normalize_title(input_title),
    _normalize_title(candidate_title),
).ratio()
```

[mylibrary/enrich.py:78](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:78).

Candidates are sorted descending by that ratio. Python’s stable sort means equal-similarity candidates retain catalog response order [mylibrary/enrich.py:103](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:103).

Only the top candidate’s similarity and, if present, the second candidate’s similarity affect confidence [mylibrary/enrich.py:108](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:108).

### Exact surname comparison

`_surname(author)` returns `""` for a falsy author. Otherwise it normalizes the author using the same subtitle-dropping `_normalize_title()` function and returns the final space-separated token [mylibrary/enrich.py:45](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:45).

For the best search candidate, `author_ok` is true if any of these conditions is true:

1. The input book has no truthy author.
2. The best candidate has no truthy `author`.
3. `_surname(book.author) == _surname(candidate.author)`.
4. `_surname(book.author)` is a substring of `_normalize_title(candidate.author)`.

See [mylibrary/enrich.py:111](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:111).

Condition 4 is a raw Python substring test, not a token or word-boundary test. If the book author is truthy but normalizes to an empty surname, the empty string is a substring of every normalized candidate author.

### Exhaustive label rules

#### HIGH

A result is `HIGH` only through one of these paths:

1. `book.isbn13` is truthy and `catalog.openlibrary_by_isbn(book.isbn13)` returns a truthy candidate.
2. The Open Library ISBN call returned no candidate, and `catalog.googlebooks_by_isbn(book.isbn13)` returns a truthy candidate.

No similarity, author, title, or ISBN-confirmation check is applied after either candidate is returned [mylibrary/enrich.py:153](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:153).

#### MEDIUM

A search result is `MEDIUM` if and only if all of the following are true:

1. The catalog candidate list is non-empty.
2. The best candidate’s normalized-title similarity is at least `0.85`.
3. `author_ok` is true under one of the four rules above.
4. The result is not ambiguous.
5. “Ambiguous” means both:
   - best similarity is at least `0.85`; and
   - second-best similarity is at least `0.85`.

See [mylibrary/enrich.py:93](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:93), [mylibrary/enrich.py:118](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:118).

Thus two strong title matches force LOW even if the top candidate has the correct author and the second does not. Candidate authors are not used to disambiguate the second result.

#### LOW with a candidate

For every non-empty candidate list not satisfying the complete MEDIUM condition, `_score_candidates()` returns the best candidate with `LOW`.

The implementation has two branches:

- `best_sim >= 0.60` → LOW
- `best_sim < 0.60` → LOW

Therefore the weak threshold does not change the output at present; every non-empty, non-MEDIUM list is LOW [mylibrary/enrich.py:121](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:121).

Stored LOW candidate rows receive:

- `confidence_label = "LOW"`
- `resolution_confidence = 0.30`

via `_apply()` [mylibrary/enrich.py:144](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:144).

#### Unresolved

An empty candidate list makes `_score_candidates()` return `(None, "NONE")` [mylibrary/enrich.py:100](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:100).

If every resolution path is empty, `_resolve_one()` returns `(None, "NONE", "unresolved")` [mylibrary/enrich.py:177](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:177). Persistence deliberately converts this to:

- `confidence_label = "LOW"`
- `resolution_confidence = 0.0`
- `match_method = "unresolved"`

[mylibrary/enrich.py:255](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:255).

There is therefore no persisted `"NONE"` confidence label.

### Complete `match_method` set

| Value | Exact producing path |
|---|---|
| `isbn:openlibrary` | Truthy Open Library ISBN result [mylibrary/enrich.py:153](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:153). |
| `isbn:googlebooks` | Open Library ISBN failed and Google ISBN returned a candidate [mylibrary/enrich.py:157](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:157). |
| `search:openlibrary` | Open Library produced a MEDIUM result; or neither search produced MEDIUM and Open Library had any candidate, which becomes the LOW fallback [mylibrary/enrich.py:162](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:162), [mylibrary/enrich.py:172](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:172). |
| `search:googlebooks` | Open Library did not produce MEDIUM, and Google produced MEDIUM; or Open Library had no candidate and Google supplied a LOW fallback [mylibrary/enrich.py:167](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:167), [mylibrary/enrich.py:175](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:175). |
| `unresolved` | No ISBN result and neither search supplied any candidate [mylibrary/enrich.py:177](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:177). |

---

## 4. The `Enrichment` row

### Schema

The Python model has these columns:

- `id`
- `book_id`
- `resolved_source`
- `resolved_id`
- `subjects`
- `series`
- `series_position`
- `language`
- `description`
- `cover_url`
- `resolution_confidence`
- `confidence_label`
- `match_method`
- `raw_response`
- `resolved_at`

See [mylibrary/db.py:121](/home/chase/Documents/Code/my-library/mylibrary/db.py:121).

`book_id` is unique, so there can be at most one enrichment row per book [mylibrary/db.py:124](/home/chase/Documents/Code/my-library/mylibrary/db.py:124).

### Common mapping for every resolved candidate

`_apply()` writes:

| Column | Derivation |
|---|---|
| `id` | Database-generated primary key; `_apply()` does not touch it [mylibrary/db.py:124](/home/chase/Documents/Code/my-library/mylibrary/db.py:124). |
| `book_id` | Set to `book.id` only when constructing a missing row [mylibrary/enrich.py:250](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:250). Existing rows retain it. |
| `resolved_source` | `cand.get("source")` [mylibrary/enrich.py:126](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:126). |
| `resolved_id` | `cand.get("resolved_id")` [mylibrary/enrich.py:128](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:128). |
| `subjects` | `cand.get("subjects") or []`; any absent, `None`, or empty source value becomes an empty list [mylibrary/enrich.py:130](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:130). |
| `series` | `cand.get("series")`; current enrichment catalog candidates do not populate this key, so it is `None` [mylibrary/enrich.py:131](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:131), [mylibrary/catalog.py:204](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:204), [mylibrary/catalog.py:313](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:313), [mylibrary/catalog.py:349](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:349). |
| `series_position` | `cand.get("series_position")`; current enrichment candidates do not populate this key, so it is `None` [mylibrary/enrich.py:132](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:132), with the same candidate constructors cited above. |
| `language` | `cand.get("language")`; absent keys produce `None` [mylibrary/enrich.py:133](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:133). |
| `description` | Candidate description, possibly followed by the Open Library Work fallback described below [mylibrary/enrich.py:134](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:134). |
| `cover_url` | `cand.get("cover_url")`; absent fields become `None` [mylibrary/enrich.py:143](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:143). |
| `confidence_label` | Resolution label returned by `_resolve_one()` [mylibrary/enrich.py:144](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:144). |
| `resolution_confidence` | `_CONF[label]`: 0.95, 0.70, or 0.30 for resolved candidates [mylibrary/enrich.py:145](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:145). |
| `match_method` | Method returned by `_resolve_one()` [mylibrary/enrich.py:146](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:146). |
| `raw_response` | `cand.get("raw")`; no trimming or normalization [mylibrary/enrich.py:147](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:147). |
| `resolved_at` | Fresh `utcnow()` on every resolved write [mylibrary/enrich.py:148](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:148). |

There is no joining, string truncation, or subject deduplication in `_apply()` [mylibrary/enrich.py:126](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:126).

### Open Library ISBN candidate

`openlibrary_by_isbn()` derives:

- `source`: literal `"openlibrary"`.
- `resolved_id`: the ISBN Books API record’s `key`, normally an edition path such as `/books/OL...M`.
- `title`: `record["title"]` if present.
- `subjects`: each truthy `name` from the record’s `subjects` array, preserving source order and duplicates; no cap.
- `cover_url`: `record.cover.medium`.
- `description`: record `description`, otherwise record `notes`; if it is an object, use its `value`; if it is a string, use it directly; other types become `None`.
- `raw`: `{"isbn": requested_isbn, "record": complete_record}`.

See [mylibrary/catalog.py:186](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:186), [mylibrary/catalog.py:204](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:204), [mylibrary/catalog.py:215](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:215).

If the edition record lacks a description and has an edition key:

1. Fetch `https://openlibrary.org/<edition-key-without-leading-slash>.json`.
2. Read its `works` array.
3. Take only the first work’s `key`.
4. Fetch `https://openlibrary.org/<work-key-without-leading-slash>.json`.
5. Extract description/notes using the same rule.

See [mylibrary/catalog.py:198](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:198), [mylibrary/catalog.py:222](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:222), [mylibrary/catalog.py:239](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:239).

Open Library ISBN candidates contain no `author`, `series`, `series_position`, or `language` keys [mylibrary/catalog.py:204](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:204). Accordingly, persisted series, position, and language are `None`.

### Open Library search candidate

For each of at most five source documents:

- `source`: `"openlibrary"`.
- `resolved_id`: `doc.key`, normally a Work key.
- `title`: `doc.title`.
- `author`: first element of `doc.author_name`, otherwise `None`; this participates in scoring but is not persisted.
- `subjects`: first 25 entries of `doc.subject`; no deduplication.
- `cover_url`: `https://covers.openlibrary.org/b/id/<cover_i>-M.jpg` if `cover_i` is truthy, otherwise `None`.
- `year`: `doc.first_publish_year`; not persisted to `Enrichment`.
- `language`: normalized from `doc.language`.
- `raw`: the complete search document.

See [mylibrary/catalog.py:301](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:301).

Language normalization:

1. If the value is a list, take only its first element.
2. Missing/empty becomes `None`.
3. Convert to string, trim, lowercase.
4. Known three-letter codes use `_LANG_MAP`.
5. Otherwise take the first two characters.

See [mylibrary/catalog.py:163](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:163), [mylibrary/catalog.py:170](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:170).

Search candidates do not initially carry `description`. Because their resolved ID is normally `/works/...`, `_apply()` calls `openlibrary_work_description(resolved_id)` if description is absent [mylibrary/enrich.py:134](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:134). If that fetch fails or contains no usable description/notes, `description` remains `None` [mylibrary/catalog.py:222](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:222).

### Google Books ISBN and search candidates

Both use the same `_google_books_query()` mapping:

- `source`: `"googlebooks"`.
- `resolved_id`: top-level item `id`.
- `title`: `volumeInfo.title`.
- `author`: first `volumeInfo.authors` entry, otherwise `None`; used for scoring but not persisted.
- `subjects`: `volumeInfo.categories` or `[]`; no cap or deduplication.
- `description`: `volumeInfo.description`.
- `cover_url`: `volumeInfo.imageLinks.thumbnail`.
- `year`: integer parsed from the first four characters of `publishedDate`, otherwise `None`; not persisted to enrichment.
- `language`: normalized with the common language routine.
- `raw`: complete Google item.

See [mylibrary/catalog.py:336](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:336), [mylibrary/catalog.py:346](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:346), [mylibrary/catalog.py:366](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:366).

No Google-specific description fallback occurs.

### Unresolved rows

For a newly created unresolved row, explicit writes are limited to:

- `book_id`
- `confidence_label = "LOW"`
- `resolution_confidence = 0.0`
- `match_method = "unresolved"`
- `resolved_at = utcnow()`

[mylibrary/enrich.py:250](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:250), [mylibrary/enrich.py:255](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:255).

Other columns use their ORM/database defaults, which are effectively `NULL`; `subjects` is not converted to `[]` on the unresolved path [mylibrary/db.py:127](/home/chase/Documents/Code/my-library/mylibrary/db.py:127).

---

## 5. Existing-row and upsert semantics

This is ORM mutation, not a SQL `ON CONFLICT` upsert.

### Without `force`

An eligible book with any existing row is skipped, except when `retry_unresolved=True` and `resolved_source is None` [mylibrary/enrich.py:227](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:227).

Skipped rows are completely unchanged.

### With `force`, or a retry-eligible unresolved row

The existing object is reused:

```python
enr = book.enrichment
if enr is None:
    enr = Enrichment(book_id=book.id)
```

[mylibrary/enrich.py:250](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:250).

Thus an existing row is updated in place. It is not deleted or replaced, and its `id` and `book_id` are preserved.

If the new attempt resolves, `_apply()` overwrites all of these columns:

- `resolved_source`
- `resolved_id`
- `subjects`
- `series`
- `series_position`
- `language`
- `description`
- `cover_url`
- `confidence_label`
- `resolution_confidence`
- `match_method`
- `raw_response`
- `resolved_at`

[mylibrary/enrich.py:126](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:126).

Because assignments are unconditional, missing values overwrite prior values with `None`, and missing subjects overwrite prior subjects with `[]`.

If the new attempt is unresolved, only these columns are overwritten:

- `confidence_label`
- `resolution_confidence`
- `match_method`
- `resolved_at`

[mylibrary/enrich.py:255](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:255).

All prior metadata—including `resolved_source`, `resolved_id`, subjects, series, language, description, cover, and raw response—is preserved on that unresolved path.

That creates a notable edge case: forcing a previously resolved row and then failing to resolve it leaves the old non-`None` `resolved_source` in place, while changing confidence to LOW/0.0 and method to `unresolved`. A later `retry_unresolved=True` run will not select that row because retry eligibility tests only `resolved_source is None` [mylibrary/enrich.py:227](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:227).

---

## 6. Progress callback and HTTP statistics

### Progress contract

The type is:

```python
Callable[[int, int, str, str], None] | None
```

[mylibrary/enrich.py:186](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:186).

The positional signature is:

```text
(done, total, title, label)
```

[mylibrary/enrich.py:195](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:195).

It fires:

1. Once before the first lookup, including when `work` is empty:

   ```python
   progress(skipped, full_total, "", "starting")
   ```

   [mylibrary/enrich.py:243](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:243).

2. Once after each book’s commit:

   ```python
   progress(skipped + i, full_total, book.title, label)
   ```

   [mylibrary/enrich.py:267](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:267).

For resolved books, `label` is `HIGH`, `MEDIUM`, or `LOW`. For a no-candidate result, it is changed from internal `NONE` to the literal lowercase `"unresolved"` before callback invocation [mylibrary/enrich.py:255](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:255).

The callback’s return value is ignored. Exceptions are not caught, so a callback exception escapes after the current book has committed [mylibrary/enrich.py:267](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:267).

### HTTP statistics

Statistics live in the module-global `catalog._stats` dictionary [mylibrary/catalog.py:54](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:54). They are reset at the beginning of every enrichment invocation [mylibrary/enrich.py:206](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:206).

The final block contains:

```json
{
  "requests": 0,
  "rate_limited": 0,
  "server_errors": 0,
  "network_errors": 0,
  "retries": 0,
  "by_host": {
    "<hostname>": {
      "requests": 0,
      "rate_limited": 0
    }
  }
}
```

[mylibrary/catalog.py:59](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:59).

Exact counting:

- `requests`: incremented for each actual HTTP attempt, including retries [mylibrary/catalog.py:114](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:114).
- `by_host[host].requests`: same, scoped by URL hostname [mylibrary/catalog.py:111](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:111).
- `retries`: incremented when `attempt > 1`, immediately before that retry attempt [mylibrary/catalog.py:118](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:118).
- `network_errors`: incremented for every caught `httpx.HTTPError`, including failures that will be retried [mylibrary/catalog.py:121](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:121).
- `rate_limited`: incremented for every HTTP 429 response [mylibrary/catalog.py:135](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:135).
- `by_host[host].rate_limited`: same 429 count by host [mylibrary/catalog.py:136](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:136).
- `server_errors`: incremented for each 500, 502, 503, or 504 response [mylibrary/catalog.py:135](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:135).

Cache hits do not increment any counter because `_get_json()` returns before determining the host or entering the request loop [mylibrary/catalog.py:99](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:99).

`get_stats()` converts the nested `defaultdict` to ordinary JSON-serializable dictionaries [mylibrary/catalog.py:71](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:71).

---

## 7. Existing Node catalog and cache surface

### `catalogCache.ts`

The Node cache replaces Python’s SHA-1-named disk files with the existing Postgres `catalog_cache` table [frontend/lib/server/catalogCache.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/catalogCache.ts:1).

Current functions:

```ts
cacheKeyFor(url: string): string
```

Returns SHA-1 of the UTF-8 URL [frontend/lib/server/catalogCache.ts:11](/home/chase/Documents/Code/my-library/frontend/lib/server/catalogCache.ts:11).

```ts
cacheGet(db: Db, url: string): Promise<{
  hit: boolean;
  payload: unknown;
}>
```

It distinguishes a missing row from a cached JSON `null`, allowing negative caching [frontend/lib/server/catalogCache.ts:15](/home/chase/Documents/Code/my-library/frontend/lib/server/catalogCache.ts:15), [frontend/lib/server/catalogCache.ts:21](/home/chase/Documents/Code/my-library/frontend/lib/server/catalogCache.ts:21).

```ts
cachePut(
  db: Db,
  url: string,
  source: string,
  payload: unknown
): Promise<void>
```

It inserts or updates by cache key, overwriting payload, source, and fetch timestamp [frontend/lib/server/catalogCache.ts:30](/home/chase/Documents/Code/my-library/frontend/lib/server/catalogCache.ts:30).

The corresponding table already exists with `cacheKey`, `source`, non-null JSONB `payload`, and `fetchedAt` [frontend/lib/server/schema.ts:255](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:255).

These three functions are directly reusable as-is for enrichment.

### `catalog.ts` reusable functions

The generic fetch/cache layer is already present:

```ts
setRate(requestsPerSecond: number): void
```

[frontend/lib/server/catalog.ts:21](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:21).

```ts
getJson(
  db: Db,
  url: string,
  source: string
): Promise<unknown | null>
```

[frontend/lib/server/catalog.ts:41](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:41).

`getJson()` already provides:

- Postgres cache lookup.
- two total attempts;
- throttling;
- 15-second abort;
- negative caching on 404;
- retries for 429/500/502/503/504;
- numeric `Retry-After` support;
- JSON parsing;
- cache writes.

See [frontend/lib/server/catalog.ts:41](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:41).

Normalization helpers already present:

```ts
normLang(
  code: string | string[] | null | undefined
): string | null
```

[frontend/lib/server/catalog.ts:112](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:112).

```ts
yearFromGoogle(
  published: string | null | undefined
): number | null
```

[frontend/lib/server/catalog.ts:120](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:120).

```ts
isbn13FromGoogleItem(
  item: Record<string, any> | null
): string | null
```

[frontend/lib/server/catalog.ts:126](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:126).

The common normalized result type is `Candidate` [frontend/lib/server/catalog.ts:137](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:137).

Google’s generic query function is directly usable as the underlying implementation for both Google enrichment lookups:

```ts
googleBooksQuery(
  db: Db,
  q: string,
  maxResults?: number
): Promise<Candidate[]>
```

Its default is five results [frontend/lib/server/catalog.ts:153](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:153). It already maps Google title, first author, categories, description, thumbnail, year, language, and raw item with Python-equivalent field semantics [frontend/lib/server/catalog.ts:161](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:161).

The Work description helper is also present:

```ts
openlibraryWorkDescription(
  db: Db,
  workKey: string
): Promise<string | null>
```

[frontend/lib/server/catalog.ts:419](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:419).

### Existing functions that are not enrichment-equivalent as-is

```ts
openlibraryQuery(
  db: Db,
  query: string,
  maxResults?: number
): Promise<Candidate[]>
```

is a free-text `q=` search, not enrichment’s `title=` plus optional `author=` search [frontend/lib/server/catalog.ts:197](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:197).

```ts
openlibraryTitle(
  db: Db,
  title: string,
  maxResults?: number
): Promise<Candidate[]>
```

uses `title=`, but:

- accepts no author;
- defaults to 20 results, not five;
- requests an explicit trimmed `fields` set;
- its candidate converter derives an ISBN-13.

See [frontend/lib/server/catalog.ts:178](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:178), [frontend/lib/server/catalog.ts:214](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:214).

Python enrichment’s `openlibrary_search()` sends no `fields` parameter, includes `author` when present, and fixes `limit=5` [mylibrary/catalog.py:301](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:301). Therefore neither existing Open Library search function reproduces the enrichment request URL and payload as-is.

`searchBooks()` is a user-facing cross-catalog search/merge/ranking pipeline, not the enrichment resolution sequence [frontend/lib/server/catalog.ts:297](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:297).

### Enrichment catalog capabilities missing on Node

There is no current Node equivalent for:

- `openlibrary_by_isbn(isbn)`.
- `_ol_edition_work_key(edition_key)`.
- the exact `openlibrary_search(title, author)` enrichment request.
- named `googlebooks_by_isbn(isbn)` and `googlebooks_search(title, author)` wrappers, although `googleBooksQuery()` supplies their underlying fetch and normalization behavior.
- Python’s catalog request statistics/reset/snapshot API.

The existing file ends its Open Library description implementation at `openlibraryWorkDescription()` and contains no ISBN or enrichment-specific lookup exports [frontend/lib/server/catalog.ts:407](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:407).

The Node database schema already contains every enrichment column required by Python, including `language` [frontend/lib/server/schema.ts:128](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:128).

---

## 8. Existing synchronous `POST /enrich` contract

### Request

The route accepts `EnrichRequest` with exactly these HTTP body fields:

```json
{
  "force": false,
  "limit": null,
  "include_unrated": false
}
```

[mylibrary/schemas.py:19](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:19).

`retry_unresolved` and `requests_per_second` are core-function options but are not exposed by the compatibility endpoint [mylibrary/api.py:585](/home/chase/Documents/Code/my-library/mylibrary/api.py:585).

The endpoint invokes:

```python
enrich_library(
    force=req.force,
    limit=req.limit,
    include_unrated=req.include_unrated,
    user_id=user_id,
)
```

[mylibrary/api.py:577](/home/chase/Documents/Code/my-library/mylibrary/api.py:577).

### Response

There is no Pydantic response model. The route returns the summary dictionary directly [mylibrary/api.py:577](/home/chase/Documents/Code/my-library/mylibrary/api.py:577). Its shape is the eight-key summary documented in sections 1 and 6.

The endpoint blocks until synchronous enrichment completes [mylibrary/api.py:579](/home/chase/Documents/Code/my-library/mylibrary/api.py:579).

### Authentication

The `user_id: UserId` parameter installs the `current_user` dependency [mylibrary/api.py:238](/home/chase/Documents/Code/my-library/mylibrary/api.py:238).

`current_user`:

- verifies the Supabase JWT when auth is configured;
- otherwise returns `LOCAL_USER_ID`;
- stores the resolved ID in `request.state.user_id`;
- converts `AuthError` to HTTP 401.

See [mylibrary/api.py:219](/home/chase/Documents/Code/my-library/mylibrary/api.py:219).

The resolved user ID scopes the enrichment selection query [mylibrary/enrich.py:217](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:217).

### Rate limiting

There is no SlowAPI decorator on `POST /enrich`. The route docstring explicitly states that it is not rate-limited [mylibrary/api.py:577](/home/chase/Documents/Code/my-library/mylibrary/api.py:577).

Catalog outbound-request throttling is separate from HTTP endpoint rate limiting.

---

## 9. Catalog fixture recording and replay

### Recording

`fixtures/catalog/http.json` is generated by:

```bash
python scripts/gen_catalog_fixtures.py
```

[scripts/gen_catalog_fixtures.py:1](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:1).

The script:

- uses a temporary `MYLIBRARY_DATA_DIR`, avoiding the real Python disk cache [scripts/gen_catalog_fixtures.py:6](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:6);
- monkeypatches `httpx.get` with `_spy()` [scripts/gen_catalog_fixtures.py:36](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:36);
- records each URL as `{status, body}` [scripts/gen_catalog_fixtures.py:40](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:40);
- strips `&key=<Google API key>` from recorded URLs [scripts/gen_catalog_fixtures.py:46](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:46);
- runs only `catalog.search_books(q, max_results=8)` for:
  - `dune`
  - `ancillary justice`
  - `9780316246620`

  [scripts/gen_catalog_fixtures.py:33](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:33), [scripts/gen_catalog_fixtures.py:54](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:54).

It writes:

- captured HTTP to `http.json`;
- normalized Python outputs to `expected.json`.

[scripts/gen_catalog_fixtures.py:58](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:58).

### Node replay

`installHttpReplay(fixtures, onCall?)` replaces `globalThis.fetch` and performs an exact URL lookup in the fixture map [frontend/lib/server/__tests__/helpers/httpReplay.ts:24](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/httpReplay.ts:24).

An unrecorded URL throws `HttpReplayMissError`; it does not access the network [frontend/lib/server/__tests__/helpers/httpReplay.ts:17](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/httpReplay.ts:17), [frontend/lib/server/__tests__/helpers/httpReplay.ts:42](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/httpReplay.ts:42).

The catalog parity test:

1. Deletes `GOOGLE_BOOKS_API_KEY`.
2. Raises outbound RPS to avoid test delays.
3. Installs `http.json`.
4. Runs `searchBooks(db, query, 8)`.
5. Compares normalized results with `expected.json`, excluding only the large `raw` field.

See [frontend/lib/server/__tests__/catalog-search.test.ts:14](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/catalog-search.test.ts:14), [frontend/lib/server/__tests__/catalog-search.test.ts:35](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/catalog-search.test.ts:35).

### Can this recorder capture an enrichment run?

No.

It records only calls made by `catalog.search_books()` [scripts/gen_catalog_fixtures.py:54](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:54). That path does not execute `enrich_library()` or the enrichment-specific lookup sequence.

The existing fixture therefore does not intentionally capture:

- Open Library ISBN Books API URLs.
- Open Library edition-record URLs used for edition-to-work traversal.
- Open Library Work description URLs reached from ISBN enrichment.
- Exact enrichment `title=<...>&limit=5&author=<...>` search URLs.
- Google `isbn:<isbn>` queries.
- Google `intitle:"..." inauthor:"..."` enrichment queries.
- Any seeded library books, enrichment writes, confidence/method results, or final enrichment summary.

Those calls originate in the enrichment resolution path [mylibrary/enrich.py:151](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:151) and Open Library ISBN description traversal [mylibrary/catalog.py:186](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:186), neither of which the recorder invokes.

What is missing is an enrichment-specific recording scenario: isolated book seed data plus an invocation of `enrich_library()`—or direct invocation of every enrichment lookup path—and captured expected persisted rows/summary alongside all emitted HTTP URLs. The current recorder cannot produce a complete Wave 4c-1 replay fixture as written.

---

## 10. `tests/test_enrich.py` inventory

The file contains seven tests:

1. `test_normalize_title_drops_subtitle_and_punctuation` — verifies subtitle removal after `:`, removal of parenthetical edition text, and punctuation-to-space normalization [tests/test_enrich.py:18](/home/chase/Documents/Code/my-library/tests/test_enrich.py:18).
2. `test_search_title_strips_series_parenthetical` — verifies search preprocessing removes series parentheses, preserves case, and leaves a plain title unchanged [tests/test_enrich.py:24](/home/chase/Documents/Code/my-library/tests/test_enrich.py:24).
3. `test_title_sim_is_high_for_near_match` — verifies the `SequenceMatcher` score for reordered “The Name of the Wind” wording exceeds `0.6` [tests/test_enrich.py:31](/home/chase/Documents/Code/my-library/tests/test_enrich.py:31).
4. `test_strong_unique_match_scores_medium` — verifies a unique exact-title, surname-compatible best candidate is selected and labeled MEDIUM [tests/test_enrich.py:35](/home/chase/Documents/Code/my-library/tests/test_enrich.py:35).
5. `test_ambiguous_common_title_scores_low` — verifies two strong same-title candidates make the result LOW [tests/test_enrich.py:46](/home/chase/Documents/Code/my-library/tests/test_enrich.py:46).
6. `test_weak_match_scores_low` — verifies a weak/mismatched best candidate is still returned as LOW [tests/test_enrich.py:56](/home/chase/Documents/Code/my-library/tests/test_enrich.py:56).
7. `test_no_candidates_scores_none` — verifies an empty list returns `candidate is None` and internal label `NONE` [tests/test_enrich.py:63](/home/chase/Documents/Code/my-library/tests/test_enrich.py:63).

This test file does not exercise:

- `_resolve_one()`;
- ISBN ordering;
- cross-catalog fallback;
- persistence;
- force/retry/limit selection;
- summaries;
- progress;
- HTTP stats.

Its imports are limited to the normalization and candidate-scoring helpers [tests/test_enrich.py:5](/home/chase/Documents/Code/my-library/tests/test_enrich.py:5).

---

## 11. In-scope capabilities with no Node equivalent

The following synchronous-core functionality has no current Node equivalent:

- The `enrich_library()` orchestration itself: user-scoped eligibility, force/retry rules, limit semantics, per-book commits, summary counters, and progress calls [mylibrary/enrich.py:180](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:180).
- The exact `_resolve_one()` resolution/fallback sequence [mylibrary/enrich.py:151](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:151).
- `_normalize_title()`, `_surname()`, `_title_sim()`, `_search_title()`, and `_score_candidates()` enrichment matching behavior [mylibrary/enrich.py:35](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:35), [mylibrary/enrich.py:93](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:93).
- A direct equivalent of Python `difflib.SequenceMatcher.ratio()`, which supplies the exact similarity values [mylibrary/enrich.py:21](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:21), [mylibrary/enrich.py:78](/home/chase/Documents/Code/my-library/mylibrary/enrich.py:78). No corresponding similarity implementation is present in the current Node catalog module.
- Open Library ISBN lookup and edition-to-work traversal [mylibrary/catalog.py:186](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:186), [mylibrary/catalog.py:239](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:239).
- The exact Open Library enrichment title-and-author search [mylibrary/catalog.py:301](/home/chase/Documents/Code/my-library/mylibrary/catalog.py:301).
- Named Google enrichment ISBN/title-author lookup operations, although the generic `googleBooksQuery()` fetcher is already present [frontend/lib/server/catalog.ts:153](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:153).
- Per-run outbound HTTP statistics. Node `getJson()` retries and caches, but it has no reset/get statistics surface and does not count 429s, 5xx responses, network errors, retries, or requests by host [frontend/lib/server/catalog.ts:41](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:41).
- An enrichment-specific catalog fixture recorder and expected enrichment-run fixture; the current recorder invokes only `search_books()` [scripts/gen_catalog_fixtures.py:54](/home/chase/Documents/Code/my-library/scripts/gen_catalog_fixtures.py:54).
- A Node `POST /enrich` route handler. The current route tree includes catalog search and per-book enrichment correction, but no synchronous enrichment route; the client still issues `POST /enrich` through `runEnrich()` [frontend/lib/api.ts:536](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:536).

The database tables, enrichment columns, catalog cache, generic retry/cache fetcher, language normalization, Google candidate mapping, and Open Library Work-description fetch are already present and do not require new persistence infrastructure [frontend/lib/server/schema.ts:128](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:128), [frontend/lib/server/schema.ts:255](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:255), [frontend/lib/server/catalog.ts:41](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:41).
