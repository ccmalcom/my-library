# TODO

Prioritized for the invite-only / free launch. Organizing question: what would
break or confuse the first wave of invited users, then friction, then growth.

## Wave 4 — Delight & growth

- Spotify Wrapped-style profile reveal on onboarding
  - in general, I want to spice up the onboarding flow by immediately surfacing the profile to the user (possibly each trait individually) and the user approving/denying/modifying. Also maybe we should add some more metadata to the profile like favorite genres, authors, types (short story, novella, novel, seires, etc.)
- Admin console — users, token usage, API usage, feedback (overlaps Wave 1 cost visibility)
- Social — add friends, see each other's activity, etc.

## Done

## Wave 1 — Launch blockers - COMPLETE

- Cost guardrails + rate limiting (paired; spend/abuse control under multi-user BYO-key) — **done**
  - Per-user Anthropic spend visibility/limits so big libraries don't cause a surprise bill — **done**: soft-warn spend tracking shipped (`usage_events` table, `/settings` usage panel, `UsageWarningBanner`; never blocks a call)
  - `/catalog/search` per-user rate limiting (hits OL + Google Books live per keystroke) — **already satisfied**, no code change: the existing 30/min per-user SlowAPI limit on `/catalog/search` already covers this

## Wave 2 — Onboarding friction - COMPLETE

- Custom imports — biggest adoption lever (Goodreads is import-once)
  - StoryGraph, Google Play Books, Apple Books, generic CSV / other library managers
  - Manual single-book add is a slog; reduce friction
- Backup / export of in-app ratings & reviews (trust feature, adjacent to import work)

- Cost guardrails + rate limiting — soft-warn per-user spend tracking shipped (`usage_events`, `/settings` usage panel, `UsageWarningBanner`); `/catalog/search` rate limiting was already satisfied by the existing 30/min SlowAPI limit, closed with no code change
- Invite flow / account management — admin console shipped; invite + revoke users + view roster
- BUGS — cleared
- No-Anthropic-key error UX — shows error + prompts for key on profile/recommend
- Onboarding empty state — setup/onboarding wizard shows on home / swipe / my library

## Wave 3 — Recommender depth

- "More books like this" from a selected library book (smallest, highest-visibility win, specific recommendations based only on selected book)
- NL discovery — natural-language "find me a book like X" search (builds on the above)
- Full feedback / labeling surface — surface LOW-confidence enrichment matches for correction

## Shelves & data model
