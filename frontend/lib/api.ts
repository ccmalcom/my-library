/**
 * Typed fetch client for the MyLibrary FastAPI backend.
 * All requests go to NEXT_PUBLIC_API_URL (default: http://127.0.0.1:8000).
 * In hosted mode each request carries the Supabase session token (see authHeaders).
 */

import { getSupabaseClient } from '@/utils/supabase/client';
import { baseFor } from '@/lib/backend';

// ─── Types ─────────────────────────────────────────────────────────────────────────────

export interface Stats {
  total: number;
  rated: number;
  unrated: number;
  shelves: Record<string, number>;
  mean_rating: number | null;
  by_star: Record<string, number>;
}

export interface Book {
  id: number;
  title: string;
  author: string | null;
  isbn13: string | null;
  exclusive_shelf: string | null;
  goodreads_rating: number;
  app_rating: number | null;
  app_review: string | null;
  effective_rating: number | null;
  year_published: number | null;
  page_count: number | null;
  date_read: string | null;
  date_added: string | null;
  cover_url: string | null;
  description?: string | null;
  confidence_label: string | null;
  resolution_confidence: number | null;
  exclude_from_profile: boolean;
  is_favorite: boolean;
}

export interface Recommendation {
  id: number;
  run_id: string;
  rank: number;
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  cover_url: string | null;
  subjects: string[] | null;
  description?: string | null;
  catalog_source: string | null;
  catalog_id: string | null;
  retrieval_pool: string | null;
  seed_reason: string | null;
  score: number;
  rationale: string | null;
  grounded_trait_ids: number[] | null;
  grounded_book_ids: number[] | null;
  status: string;
  user_note: string | null;
  created_at: string;
}

export interface SimilarBook {
  rank: number;
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  cover_url: string | null;
  subjects: string[] | null;
  description?: string | null;
  catalog_source: string | null;
  catalog_id: string | null;
  retrieval_pool: string | null;
  seed_reason: string | null;
  score: number;
  rationale: string | null;
}

export interface SimilarBooksResult {
  anchor_book_id: number;
  anchor_title: string;
  count: number;
  model: string;
  seed_queries: string[];
  recommendations: SimilarBook[];
}

export interface DiscoverBook {
  rank: number;
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  cover_url: string | null;
  subjects: string[] | null;
  description?: string | null;
  catalog_source: string | null;
  catalog_id: string | null;
  retrieval_pool: string | null;
  seed_reason: string | null;
  score: number;
  rationale: string | null;
}

export interface DiscoverResult {
  query: string;
  interpretation: string;
  count: number;
  model: string;
  queries: string[];
  recommendations: DiscoverBook[];
}

export interface Trait {
  id: number;
  claim: string;
  reveal_line: string | null;
  polarity: string;
  exhibits: number[] | null;
  contrasts: number[] | null;
  inference_confidence: number;
  status: string;
  user_weight: number | null;
  user_note: string | null;
  created_at: string;
}

export interface TraitUpdateRequest {
  claim?: string;
  user_note?: string;
}

export interface SubjectCount {
  subject: string;
  count: number;
}

export interface SubjectBreakdown {
  overall: SubjectCount[];
  by_tier: Record<string, SubjectCount[]>;
}

export interface ProfileHighlights {
  thin: boolean;
  n_authors: number;
  top_genres: { subject: string; share: number }[];
  top_authors: string[];
  format_mix: {
    novel: number;
    novella: number;
    collection: number;
    series: number;
    dominant: 'novel' | 'novella' | 'collection' | 'series' | null;
    low_confidence: boolean;
  };
  era_split: { pre_2000: number; post_2000: number } | null;
}

export interface FeedbackRequest {
  status?: 'accepted' | 'rejected' | 'already_read';
  user_note?: string | null;
}

/**
 * Result of a swipe decision. `book` is the library book the decision created/matched:
 * the to-read book for `accepted`, the read book for `already_read` (so the UI can
 * prompt a review), and null for `rejected`.
 */
export interface RecFeedbackResult {
  status: string;
  user_note: string | null;
  book: Book | null;
}

/** In-app re-rate / review of a library book (PATCH /books/{id}/feedback). */
export interface BookFeedbackRequest {
  /** 1-5 to set, 0 to clear the in-app rating, omit to leave unchanged. */
  rating?: number;
  /** Review text to set; omit to leave unchanged. */
  review?: string;
  /** Remove an existing review. */
  clear_review?: boolean;
  /** ISO date (YYYY-MM-DD) the book was read; omit to leave unchanged. */
  date_read?: string;
  /** Exclude this book from taste profiling/archetype derivation; omit to leave unchanged. */
  exclude_from_profile?: boolean;
  /** Mark this book as a personal favorite (strongest profiling signal); omit to leave unchanged. */
  is_favorite?: boolean;
}

export type Shelf = 'to-read' | 'currently-reading' | 'read' | 'did-not-finish';

/** One hit from the manual add-a-book search (GET /catalog/search). */
export interface CatalogResult {
  source: string;
  catalog_id: string | null;
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  cover_url: string | null;
  subjects: string[] | null;
  description: string | null;
}

/** Fields the generic importer can map to (mirrors backend MAPPING_FIELDS). */
export type MappingField =
  'title' | 'author' | 'isbn13' | 'rating' | 'review' | 'shelf' | 'date_read';

export interface ImportPreview {
  format: 'goodreads' | 'storygraph' | 'canonical' | 'unknown';
  headers: string[];
  sample_rows: Record<string, string>[];
  suggested_mapping: Record<MappingField, string | null>;
}

export interface ImportSummary {
  format: string;
  total_rows: number;
  skipped: number;
  inserted: number;
  updated: number;
  rated: number;
}

/** Manually add a book to the library (POST /books). */
export interface AddBookRequest {
  title: string;
  author?: string | null;
  year?: number | null;
  isbn13?: string | null;
  shelf?: Shelf;
  /** 1-5 to rate on add (feeds the taste profile); omit for unrated. */
  rating?: number | null;
  /** Optional review text — a strong, direct taste signal. */
  review?: string | null;
  cover_url?: string | null;
  subjects?: string[] | null;
  catalog_source?: string | null;
  catalog_id?: string | null;
}

/** Re-point a book's enrichment at a user-picked catalog match (PATCH /books/{id}/enrichment). */
export interface EnrichmentCorrectionRequest {
  catalog_source: string;
  catalog_id: string;
  cover_url?: string | null;
  subjects?: string[] | null;
  description?: string | null;
}

/** Summary returned by the book mutation endpoints (not a full Book). */
export interface BookFeedbackResult {
  id: number;
  title: string;
  author: string | null;
  exclusive_shelf: string | null;
  app_rating: number | null;
  goodreads_rating: number;
  effective_rating: number | null;
  app_review: string | null;
  date_read: string | null;
  feedback_updated_at: string | null;
}

/** Whether the taste profile is stale relative to in-app edits (GET /profile/status). */
export interface ProfileStatus {
  dirty: boolean;
  changed_books: number;
  changed_book_ids: number[];
  last_profiled_at: string | null;
  last_profile_kind: string | null;
}

export interface ApiKeyStatus {
  /** True when a usable Anthropic key exists (stored per-user or env fallback). */
  configured: boolean;
}

/** One axis score from the reader archetype (lens / engine / range / resonance). */
export interface ArchetypeAxisOut {
  score: number;
  /** Winning pole letter, e.g. 'I' or 'R'. */
  letter: string;
  rationale: string | null;
}

/** Reader archetype returned by GET/POST /profile/archetype. */
export interface ArchetypeOut {
  code: string;
  name: string;
  tagline: string;
  /** Extends the tagline for the reveal finale: "You're the one who {hook}." */
  hook: string;
  lens: ArchetypeAxisOut;
  engine: ArchetypeAxisOut;
  range: ArchetypeAxisOut;
  resonance: ArchetypeAxisOut;
  derived_at: string;
  /** True when the archetype was derived before the most recent profile build. */
  is_stale: boolean;
}

export interface UserProfile {
  /** The user's chosen display name, or null if not yet set. */
  display_name: string | null;
}

export interface FeedbackSubmit {
  category: string;
  body: string;
  trigger?: string | null;
  run_id?: string | null;
  page?: string | null;
  app_version?: string | null;
}

export interface FeedbackDismiss {
  trigger: string;
  run_id?: string | null;
  mode: 'ask_later' | 'dont_ask';
}

export interface FeedbackPromptResponse {
  show: boolean;
}

/**
 * Shared SWR key for the profile-status query, so any mutation (a re-rate/review)
 * can revalidate the re-profile banner via `mutate(PROFILE_STATUS_KEY)`.
 */
export const PROFILE_STATUS_KEY = 'profile-status';

/** Shared SWR key for the reader archetype (GET /profile/archetype). */
export const ARCHETYPE_KEY = 'archetype';

/** Shared SWR key for the computed shelf highlights (GET /profile/highlights). */
export const PROFILE_HIGHLIGHTS_KEY = 'profile-highlights';

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Auth header for the FastAPI backend. In hosted mode this is the Supabase session's access
 * token (the backend verifies it via JWKS). In local mode (no Supabase configured) it's
 * empty and the backend serves the "local" user — so the app works unauthenticated in dev.
 */
async function authHeaders(): Promise<Record<string, string>> {
  const supabase = getSupabaseClient();
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${baseFor(path, 'GET')}${path}`, {
    cache: 'no-store',
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseFor(path, 'POST')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseFor(path, 'PATCH')}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PATCH ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseFor(path, 'PUT')}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PUT ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${baseFor(path, 'DELETE')}${path}`, {
    method: 'DELETE',
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`DELETE ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

// ─── API calls ────────────────────────────────────────────────────────────────────────────

export const api = {
  stats: () => get<Stats>('/stats'),

  health: () => get<{ status: string; books: number; anthropic_key_set: boolean }>('/health'),

  books: (params?: { shelf?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.shelf) qs.set('shelf', params.shelf);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return get<Book[]>(query ? `/books?${query}` : '/books');
  },

  recommendations: () => get<Recommendation[]>('/recommendations'),

  /** Ephemeral "more books like this" for one library book (Wave 3a). */
  similarBooks: (bookId: number, n = 8) =>
    post<SimilarBooksResult>(`/books/${bookId}/similar`, { n }),

  /** Natural-language discovery: "find me a book like X" (Wave 3b). Ephemeral — not persisted. */
  discover: (query: string, n = 10) => post<DiscoverResult>('/discover', { query, n }),

  profile: () => get<Trait[]>('/profile'),

  updateTrait: (traitId: number, req: TraitUpdateRequest) =>
    patch<Trait>(`/profile/traits/${traitId}`, req),

  /** Ensure every trait has a second-person reveal line; returns all traits. Wave 4a. */
  generateRevealLines: () => post<Trait[]>('/profile/reveal-lines'),

  profileSubjects: () => get<SubjectBreakdown>('/profile/subjects'),

  profileHighlights: () => get<ProfileHighlights>('/profile/highlights'),

  runRecommend: (n = 10) => post<Record<string, unknown>>('/recommend', { n }),

  /** Build the initial taste profile (required before first recommendations). */
  runProfile: () => post<Record<string, unknown>>('/profile'),

  feedback: (recId: number, req: FeedbackRequest) =>
    patch<RecFeedbackResult>(`/recommendations/${recId}/feedback`, req),

  /** Re-rate and/or review a library book. */
  setBookFeedback: (bookId: number, req: BookFeedbackRequest) =>
    patch<BookFeedbackResult>(`/books/${bookId}/feedback`, req),

  /** Move a book to another shelf (e.g. to-read -> currently-reading / read). */
  setBookShelf: (bookId: number, shelf: Shelf) =>
    patch<BookFeedbackResult>(`/books/${bookId}/shelf`, { shelf }),

  /** Search Open Library + Google Books for the manual add-a-book picker. */
  catalogSearch: (q: string, limit = 8) =>
    get<CatalogResult[]>(`/catalog/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  /** Manually add a book to the library (from a picked catalog result). */
  addBook: (req: AddBookRequest) => post<Book>('/books', req),

  /**
   * Re-point a book's enrichment at a user-picked catalog match — fixes a
   * mis-resolved (typically LOW-confidence) match. Wave 3c "fix match" queue.
   */
  correctEnrichment: (bookId: number, req: EnrichmentCorrectionRequest) =>
    patch<Book>(`/books/${bookId}/enrichment`, req),

  /** Permanently remove a book from the library. */
  removeBook: (bookId: number) =>
    del<{ id: number; title: string; removed: boolean }>(`/books/${bookId}`),

  /** Is the taste profile stale relative to recent rating/review edits? */
  profileStatus: () => get<ProfileStatus>('/profile/status'),

  /** Incrementally refresh the taste profile from recent edits only. */
  updateProfile: () => post<Record<string, unknown>>('/profile/update'),

  /** All recommendations the user has rejected, newest first. */
  rejectedRecs: () => get<Recommendation[]>('/recommendations/rejected'),

  /** Upload a Goodreads CSV and run ingest. Used by the setup wizard. */
  ingestUpload: async (file: File): Promise<Record<string, unknown>> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${baseFor('/ingest/upload', 'POST')}/ingest/upload`, {
      method: 'POST',
      body: form,
      headers: { ...(await authHeaders()) }, // no Content-Type — the browser sets the multipart boundary
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Upload failed (${res.status}): ${detail}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  },

  /** Sniff an uploaded CSV: detected format, headers, sample rows, guessed mapping. */
  importPreview: async (file: File): Promise<ImportPreview> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${baseFor('/import/preview', 'POST')}/import/preview`, {
      method: 'POST',
      body: form,
      headers: { ...(await authHeaders()) },
    });
    if (!res.ok) throw new Error(`Preview failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<ImportPreview>;
  },

  /** Import a CSV. format='auto' auto-detects; 'generic' needs a mapping. */
  importLibrary: async (
    file: File,
    opts?: { format?: string; mapping?: Record<string, string> }
  ): Promise<ImportSummary> => {
    const form = new FormData();
    form.append('file', file);
    form.append('format', opts?.format ?? 'auto');
    if (opts?.mapping) form.append('mapping', JSON.stringify(opts.mapping));
    const res = await fetch(`${baseFor('/import', 'POST')}/import`, {
      method: 'POST',
      body: form,
      headers: { ...(await authHeaders()) },
    });
    if (!res.ok) throw new Error(`Import failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<ImportSummary>;
  },

  /** Kick off library enrichment (Open Library + Google Books). Slow — can take minutes. */
  runEnrich: (opts?: { limit?: number }) =>
    post<Record<string, unknown>>('/enrich', { limit: opts?.limit ?? null }),

  /**
   * Start a background enrichment job. Returns immediately with a job_id.
   * Poll enrichStatus(job_id) until status is 'done' or 'error'.
   */
  enrichStart: (opts?: { force?: boolean; limit?: number }) =>
    post<EnrichJobOut>('/enrich/start', {
      force: opts?.force ?? false,
      limit: opts?.limit ?? null,
    }),

  /** Poll the status and progress of an enrichment job by job_id. */
  enrichStatus: (jobId: string) => get<EnrichJobOut>(`/enrich/status/${jobId}`),

  /** Whether a usable Anthropic key is configured (stored or env fallback). Never the key. */
  apiKeyStatus: () => get<ApiKeyStatus>('/settings/api-key/status'),

  /** Store the user's Anthropic key (encrypted server-side). */
  setApiKey: (apiKey: string) => put<ApiKeyStatus>('/settings/api-key', { api_key: apiKey }),

  /** Remove the user's stored key (reverts to env fallback / unconfigured). */
  clearApiKey: () => del<ApiKeyStatus>('/settings/api-key'),

  /** Get the user's display name. */
  getProfile: () => get<UserProfile>('/settings/profile'),

  /** Set / update the user's display name. */
  setProfile: (display_name: string) => put<UserProfile>('/settings/profile', { display_name }),

  // ── Reader archetype ──────────────────────────────────────────────────────
  /** Derive (or re-derive) the reader archetype from the current taste profile. */
  deriveArchetype: () => post<ArchetypeOut>('/profile/archetype'),

  /**
   * Return the stored reader archetype. Returns null when none has been derived yet
   * (the API returns 404, which this helper converts to null).
   */
  getArchetype: async (): Promise<ArchetypeOut | null> => {
    try {
      return await get<ArchetypeOut>('/profile/archetype');
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null;
      throw e;
    }
  },

  // ── Feedback ──────────────────────────────────────────────────────────────
  /** Submit general feedback (bug, idea, etc.). */
  submitFeedback: (payload: FeedbackSubmit): Promise<void> => post<void>('/feedback', payload),

  /** Check whether a feedback prompt should be shown. */
  feedbackPrompt: (trigger: string, runId?: string): Promise<FeedbackPromptResponse> => {
    const qs = new URLSearchParams();
    qs.set('trigger', trigger);
    if (runId !== undefined) qs.set('run_id', runId);
    return get<FeedbackPromptResponse>(`/feedback/prompt?${qs.toString()}`);
  },

  /** Dismiss a feedback prompt. */
  dismissFeedback: async (payload: FeedbackDismiss): Promise<void> => {
    const res = await fetch(`${baseFor('/feedback/dismiss', 'POST')}/feedback/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`POST /feedback/dismiss → ${res.status}: ${detail}`);
    }
  },

  // ── Destructive data removal ──────────────────────────────────────────────
  /** Drop the entire library (books + enrichments) and the derived taste profile/recs. */
  clearLibrary: () => del<Record<string, number | boolean>>('/library'),

  /** Reset the taste profile (traits + recommendations); keeps the library. */
  clearProfile: () => del<Record<string, number | boolean>>('/profile'),

  /** Delete ALL of the current user's app data (library, profile, recs, stored key). */
  deleteAccount: () => del<Record<string, number | boolean>>('/account'),

  // ── Export ────────────────────────────────────────────────────────────────
  /** Download the library as a CSV or JSON blob (auth-attached). */
  exportLibrary: async (format: 'csv' | 'json'): Promise<Blob> => {
    const res = await fetch(`${baseFor('/export', 'GET')}/export?format=${format}`, {
      headers: { ...(await authHeaders()) },
    });
    if (!res.ok) throw new Error(`Export failed (${res.status}): ${await res.text()}`);
    return res.blob();
  },
};

/** Shared SWR key for the API-key status (settings page + any gating UI). */
export const API_KEY_STATUS_KEY = 'api-key-status';

// ─── Enrich job types ────────────────────────────────────────────────────────

export interface EnrichJobOut {
  job_id: string;
  /** pending | running | done | error */
  status: string;
  /** Books resolved so far in this run. */
  progress: number;
  /** Total books scheduled for this run (0 until the job starts). */
  total: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** Shared SWR key for the user's display name / profile settings. */
export const USER_PROFILE_KEY = 'user-profile';

export interface DirectiveConstraints {
  languages?: string[];
  min_year?: number;
  max_year?: number;
  exclude_subjects?: string[];
  exclude_authors?: string[];
}

export interface Directive {
  nl_text: string | null;
  constraints: DirectiveConstraints;
  updated_at: string | null;
}

export interface DirectiveDraft {
  proposed_text: string;
  constraints: DirectiveConstraints;
  conflicts: string[];
  assistant_message: string;
}

/** Shared SWR key for the user's custom instructions record. */
export const DIRECTIVE_KEY = 'directive';

// ─── Structured feedback (Tasks 3.1–3.3 backend endpoints) ────────────────────

/** Human-readable labels for recommendation reject reason codes. */
export const REJECT_REASONS: Record<string, string> = {
  wrong_genre: 'Wrong genre',
  too_dark: 'Too dark',
  tried_author: 'Already tried this author',
  too_long: 'Too long',
  not_now: 'Not in the mood',
  overhyped: 'Feels overhyped',
  wrong_vibe: 'Wrong vibe',
};

/**
 * Confirm or reject a taste-profile trait, or adjust its user weight.
 * PATCH /profile/traits/{trait_id}
 */
export function setTraitVerdict(
  id: number,
  body: { status?: 'confirmed' | 'rejected'; user_weight?: number }
): Promise<Trait> {
  return patch<Trait>(`/profile/traits/${id}`, body);
}

/**
 * Reject a recommendation and attach structured reason codes.
 * PATCH /recommendations/{rec_id}/feedback
 */
export function rejectRecWithReasons(id: number, reasons: string[]): Promise<RecFeedbackResult> {
  const body: Record<string, unknown> = { status: 'rejected' };
  if (reasons.length > 0) body.reject_reasons = reasons;
  return patch<RecFeedbackResult>(`/recommendations/${id}/feedback`, body);
}

/**
 * Record a directional taste signal (more / less of something).
 * POST /taste-signal
 */
export function recordTasteSignal(body: {
  direction: 'more' | 'less';
  target_kind: 'book' | 'rec';
  target_book_id?: number;
  snapshot?: object;
}): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/taste-signal', body);
}

/** GET /directive - the user's saved custom instructions. */
export const getDirective = (): Promise<Directive> => get<Directive>('/directive');

/** PUT /directive - save/replace the durable custom-instructions record. */
export const putDirective = (body: {
  nl_text: string | null;
  constraints: DirectiveConstraints;
}): Promise<Directive> => put<Directive>('/directive', body);

/** DELETE /directive - clear the user's custom instructions. */
export const deleteDirective = (): Promise<Directive> => del<Directive>('/directive');

/** POST /directive/draft - authoring aid; returns a proposal (never saved). */
export const draftDirective = (body: {
  message: string;
  current_text?: string | null;
}): Promise<DirectiveDraft> => post<DirectiveDraft>('/directive/draft', body);

/**
 * Toggle the favorite flag on a library book.
 * PATCH /books/{id}/feedback
 */
export function setFavorite(id: number, value: boolean): Promise<Record<string, unknown>> {
  return patch<Record<string, unknown>>(`/books/${id}/feedback`, { is_favorite: value });
}

/** Trigger a browser download of a Blob (used for library export/backup). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Admin console (Tasks 1-7) ───────────────────────────────────────────────

/** Shared SWR key for the current user's admin status (NavBar + /admin page). */
export const ADMIN_ME_KEY = 'admin-me';

/** Shared SWR key for the invited-user roster (GET /admin/users). */
export const ADMIN_USERS_KEY = 'admin-users';

export interface AdminUser {
  id: number;
  email: string;
  status: string;
  supabase_user_id: string | null;
  invited_by: string | null;
  created_at: string | null;
  revoked_at: string | null;
  book_count: number;
}

/**
 * Whether the current user is an admin. Degrades to `{ is_admin: false }` on any
 * non-OK response (e.g. unauthenticated) rather than throwing, since this is polled
 * unconditionally (NavBar) to decide whether to show admin UI at all.
 */
export async function adminMe(): Promise<{ is_admin: boolean }> {
  const res = await fetch(`${baseFor('/admin/me', 'GET')}/admin/me`, { headers: { ...(await authHeaders()) } });
  if (!res.ok) return { is_admin: false };
  return res.json() as Promise<{ is_admin: boolean }>;
}

/** Full invited-user roster (admin-only). GET /admin/users */
export const listAdminUsers = (): Promise<AdminUser[]> => get<AdminUser[]>('/admin/users');

/**
 * Invite a new user by email (admin-only). POST /admin/invite
 *
 * `displayName` / `anthropicApiKey` are optional — beta launch convenience since the admin is
 * supplying the Anthropic key; pre-provisioning them here lets the invited user skip those
 * SetupWizard steps entirely.
 */
export const inviteUser = (
  email: string,
  opts?: { displayName?: string; anthropicApiKey?: string }
): Promise<AdminUser> =>
  post<AdminUser>('/admin/invite', {
    email,
    display_name: opts?.displayName || undefined,
    anthropic_api_key: opts?.anthropicApiKey || undefined,
  });

/** Revoke an invited/active user's access (admin-only). POST /admin/revoke */
export const revokeUser = (supabaseUserId: string): Promise<{ status: string }> =>
  post<{ status: string }>('/admin/revoke', { supabase_user_id: supabaseUserId });

/**
 * Create roster rows for any Supabase auth user missing one — e.g. beta testers added
 * directly in the Supabase dashboard rather than through the Invite form (admin-only).
 * POST /admin/backfill
 */
export const backfillAdminUsers = (): Promise<{
  added: number;
  total_supabase_users: number;
}> => post<{ added: number; total_supabase_users: number }>('/admin/backfill', {});

export interface AdminUsageEvent {
  id: number;
  user_id: string;
  email: string | null;
  model: string;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface AdminUsageList {
  events: AdminUsageEvent[];
  total: number;
  total_cost_usd: number;
  limit: number;
  offset: number;
}

/** Paginated usage events across all users (admin-only). GET /admin/usage */
export function listAdminUsage(opts?: {
  limit?: number;
  offset?: number;
  operation?: string;
}): Promise<AdminUsageList> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  if (opts?.operation) params.set('operation', opts.operation);
  const qs = params.toString();
  return get<AdminUsageList>(`/admin/usage${qs ? `?${qs}` : ''}`);
}

export interface AdminFeedbackItem {
  id: number;
  user_id: string;
  email: string | null;
  category: string;
  body: string;
  trigger: string | null;
  run_id: string | null;
  page: string | null;
  app_version: string | null;
  created_at: string;
}

export interface AdminFeedbackList {
  items: AdminFeedbackItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Paginated feedback rows across all users (admin-only). GET /admin/feedback */
export function listAdminFeedback(opts?: {
  limit?: number;
  offset?: number;
  category?: string;
}): Promise<AdminFeedbackList> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  if (opts?.category) params.set('category', opts.category);
  const qs = params.toString();
  return get<AdminFeedbackList>(`/admin/feedback${qs ? `?${qs}` : ''}`);
}

// ── Spend guardrails ────────────────────────────────────────────────────────

/** Shared SWR key for the month-to-date Anthropic spend (settings panel + warning banner). */
export const USAGE_KEY = 'settings-usage';

/** Month-to-date Anthropic spend for the caller + a soft-warn flag. Read-only; never blocks. */
export interface Usage {
  spent_usd: number;
  cap_usd: number;
  pct: number;
  warn: boolean;
  by_operation: Record<string, number>;
}

/** Get the caller's month-to-date Anthropic spend. GET /settings/usage */
export const getUsage = (): Promise<Usage> => get<Usage>('/settings/usage');

// ─── Node backend admin (wave 0) ───────────────────────────────────────────────────────

export interface AdminConfig {
  debug_mode: boolean;
}

export async function getAdminConfig(): Promise<AdminConfig> {
  return get<AdminConfig>('/admin/config');
}

export async function putAdminConfig(debugMode: boolean): Promise<AdminConfig> {
  return put<AdminConfig>('/admin/config', { debug_mode: debugMode });
}

export const ADMIN_CONFIG_KEY = '/admin/config';

/** Liveness probe for the System tab. `base` is a full origin ('' = same origin). */
export async function pingBackend(base: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}${path}`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}
