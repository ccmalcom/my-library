# TODO

## BUGS

- search is not super accurate-- if you type series name, it doesn't return all of the books
  - 'one book I read is 7-8 book series, but when typed in the series name it didn't return the 8th book
  - typed 'the fault', expected the fault in our stars to come up, did not at all
    - a bunch of books about faults/geoscience, probably doing keyword searching instead of semantic
- recommender struggles with smaller sample sizes
  - Beta tester reports: recommends same books but in different languages, recommends only books from same authors as added to library

## Shelves & data model

## Onboarding

- Spotify Wrapped-style profile reveal
- if not doing goodreads import, manual book addition is a bit of a slog
- - custom imports? Other library managers?
  - custom spreadsheets, google play books, apple books, etc.

## Profiling / recommender

- Add recommendations based on selected book in library (more books like this)
-

## Roadmap gaps (from CLAUDE.md — remaining phases)

- NL discovery (natural-language "find me a book like X" search)
- Full feedback / labeling surface (surface LOW-confidence enrichment matches for correction)
- Eval harness (the stated differentiator — no clean ground truth)

## Things you may be forgetting

- Onboarding empty states: what does a brand-new user see before they have a profile / any recs? (LibraryGate covers the gate, but confirm copy + CTAs are clear)
- Cost guardrails: per-user Anthropic spend is bring-your-own-key — any visibility/limits so a user doesn't get a surprise bill on big libraries?
- Rate limiting under multi-user: /catalog/search hits OL + Google Books live per keystroke (noted in CLAUDE.md as needing per-user limits)
- Error/empty UX when a user has no Anthropic key set but tries to profile/recommend
- Invite flow / account management for invite-only launch (how do you actually invite + revoke users?)
- Backup / export: can a user get their data back out (ratings/reviews they've added in-app)?
- 'admin' console- check users, token usage, api usage, feedback, etc
- social aspect-- add friends on platform, see each others activity, etc
