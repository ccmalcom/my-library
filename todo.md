# TODO

Prioritized for the invite-only / free launch. Organizing question: what would
break or confuse the first wave of invited users, then friction, then growth.

## Wave 1 — Launch blockers

- Cost guardrails + rate limiting (paired; spend/abuse control under multi-user BYO-key)
  - Per-user Anthropic spend visibility/limits so big libraries don't cause a surprise bill
  - `/catalog/search` per-user rate limiting (hits OL + Google Books live per keystroke)

## Wave 2 — Onboarding friction

- Custom imports — biggest adoption lever (Goodreads is import-once)
  - StoryGraph, Google Play Books, Apple Books, generic CSV / other library managers
  - Manual single-book add is a slog; reduce friction
- Backup / export of in-app ratings & reviews (trust feature, adjacent to import work)

## Wave 3 — Recommender depth

- "More books like this" from a selected library book (smallest, highest-visibility win)
- NL discovery — natural-language "find me a book like X" search (builds on the above)
- Full feedback / labeling surface — surface LOW-confidence enrichment matches for correction

## Wave 4 — Delight & growth

- Spotify Wrapped-style profile reveal on onboarding
- Admin console — users, token usage, API usage, feedback (overlaps Wave 1 cost visibility)
- Social — add friends, see each other's activity, etc.

## Done

- Invite flow / account management — admin console shipped; invite + revoke users + view roster
- BUGS — cleared
- No-Anthropic-key error UX — shows error + prompts for key on profile/recommend
- Onboarding empty state — setup/onboarding wizard shows on home / swipe / my library

## Shelves & data model
