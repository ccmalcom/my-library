# TODO

## Quick wins

- ✓ add link to goodreads export help page in setup

## Shelves & data model

- ✓ add "did not finish" (DNF) shelf
- UI/DB - add 'do not use for profile' flag. Users may want to track some books but not have them included in the profile for recommendations. (relates to DNF: DNF books probably default to excluded-from-profile)
- Make to-read shelf better: should have modal view, description/details, maybe link out to bookstores
  - Mobile pass for the new to-read modal + add-book modal (recent mobile work didn't cover these)

## Profiling / recommender

- Refine profiling (and ReaderType) based on user feedback

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
