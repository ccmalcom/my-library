# TODO

## BUGS

- missing reviews flow-- save and next closed modal
- in general, saving any row takes a long time. can we speed this up?

## Beta Tester Support

- the project is now in beta testing and is invite only. I have set up each account in supabase and have configured an anthropic key for each. I want to ensure that I am actually collecting feedback from the users who are testing, so we need to have a surface for that (maybe a banner with a modal linked?). Additionally, we should prompt users to submit feedback after certain actions are taken, or even just after a certain amount of time using the app.

## Shelves & data model

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
- social aspect-- add friends on platform, see each others activity, etc
