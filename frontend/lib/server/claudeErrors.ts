/**
 * Anthropic error types and utilities.
 * Error messages are byte-exact copies from Python (mylibrary/directive.py,
 * mylibrary/reveal.py, mylibrary/archetype.py) for parity when translating
 * RuntimeError → 400 responses in Tasks 6, 7, 8.
 */

export const DISTILL_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before using the custom-instructions assistant.';

export const REVEAL_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before viewing the reveal.';

export const ARCHETYPE_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add one at /settings or set ANTHROPIC_API_KEY.';

export const PROFILE_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before running the taste-profile step.';

export const NO_RATED_BOOKS_MESSAGE = 'No rated books found. Run ingest (and enrich) first.';
