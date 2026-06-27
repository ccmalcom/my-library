/**
 * Typed fetch client for the MyLibrary FastAPI backend.
 * All requests go to NEXT_PUBLIC_API_URL (default: http://127.0.0.1:8000).
 * In hosted mode each request carries the Supabase session token (see authHeaders).
 */

import { getSupabaseClient } from "@/utils/supabase/client";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

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

export interface Trait {
  id: number;
  claim: string;
  polarity: string;
  exhibits: number[] | null;
  contrasts: number[] | null;
  inference_confidence: number;
  status: string;
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

export interface FeedbackRequest {
  status?: "accepted" | "rejected" | "already_read";
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
}

export type Shelf = "to-read" | "currently-reading" | "read" | "did-not-finish";

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
export const PROFILE_STATUS_KEY = "profile-status";

/** Shared SWR key for the reader archetype (GET /profile/archetype). */
export const ARCHETYPE_KEY = "archetype";

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
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PATCH ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PUT ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
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
  stats: () => get<Stats>("/stats"),

  health: () => get<{ status: string; books: number; anthropic_key_set: boolean }>("/health"),

  books: (params?: { shelf?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.shelf) qs.set("shelf", params.shelf);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return get<Book[]>(query ? `/books?${query}` : "/books");
  },

  recommendations: () => get<Recommendation[]>("/recommendations"),

  profile: () => get<Trait[]>("/profile"),

  updateTrait: (traitId: number, req: TraitUpdateRequest) =>
    patch<Trait>(`/profile/traits/${traitId}`, req),

  profileSubjects: () => get<SubjectBreakdown>("/profile/subjects"),

  runRecommend: (n = 10) => post<Record<string, unknown>>("/recommend", { n }),

  /** Build the initial taste profile (required before first recommendations). */
  runProfile: () => post<Record<string, unknown>>("/profile"),

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
  addBook: (req: AddBookRequest) => post<Book>("/books", req),

  /** Permanently remove a book from the library. */
  removeBook: (bookId: number) =>
    del<{ id: number; title: string; removed: boolean }>(`/books/${bookId}`),

  /** Is the taste profile stale relative to recent rating/review edits? */
  profileStatus: () => get<ProfileStatus>("/profile/status"),

  /** Incrementally refresh the taste profile from recent edits only. */
  updateProfile: () => post<Record<string, unknown>>("/profile/update"),

  /** All recommendations the user has rejected, newest first. */
  rejectedRecs: () => get<Recommendation[]>("/recommendations/rejected"),

  /** Upload a Goodreads CSV and run ingest. Used by the setup wizard. */
  ingestUpload: async (file: File): Promise<Record<string, unknown>> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/ingest/upload`, {
      method: "POST",
      body: form,
      headers: { ...(await authHeaders()) }, // no Content-Type — the browser sets the multipart boundary
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Upload failed (${res.status}): ${detail}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  },

  /** Kick off library enrichment (Open Library + Google Books). Slow — can take minutes. */
  runEnrich: (opts?: { limit?: number }) =>
    post<Record<string, unknown>>("/enrich", { limit: opts?.limit ?? null }),

  /**
   * Start a background enrichment job. Returns immediately with a job_id.
   * Poll enrichStatus(job_id) until status is 'done' or 'error'.
   */
  enrichStart: (opts?: { force?: boolean; limit?: number }) =>
    post<EnrichJobOut>("/enrich/start", {
      force: opts?.force ?? false,
      limit: opts?.limit ?? null,
    }),

  /** Poll the status and progress of an enrichment job by job_id. */
  enrichStatus: (jobId: string) => get<EnrichJobOut>(`/enrich/status/${jobId}`),

  /** Whether a usable Anthropic key is configured (stored or env fallback). Never the key. */
  apiKeyStatus: () => get<ApiKeyStatus>("/settings/api-key/status"),

  /** Store the user's Anthropic key (encrypted server-side). */
  setApiKey: (apiKey: string) =>
    put<ApiKeyStatus>("/settings/api-key", { api_key: apiKey }),

  /** Remove the user's stored key (reverts to env fallback / unconfigured). */
  clearApiKey: () => del<ApiKeyStatus>("/settings/api-key"),

  /** Get the user's display name. */
  getProfile: () => get<UserProfile>("/settings/profile"),

  /** Set / update the user's display name. */
  setProfile: (display_name: string) =>
    put<UserProfile>("/settings/profile", { display_name }),

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
  submitFeedback: (payload: FeedbackSubmit): Promise<void> =>
    post<void>('/feedback', payload),

  /** Check whether a feedback prompt should be shown. */
  feedbackPrompt: (trigger: string, runId?: string): Promise<FeedbackPromptResponse> => {
    const qs = new URLSearchParams();
    qs.set('trigger', trigger);
    if (runId !== undefined) qs.set('run_id', runId);
    return get<FeedbackPromptResponse>(`/feedback/prompt?${qs.toString()}`);
  },

  /** Dismiss a feedback prompt. */
  dismissFeedback: async (payload: FeedbackDismiss): Promise<void> => {
    const res = await fetch(`${BASE}/feedback/dismiss`, {
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
  clearLibrary: () => del<Record<string, number | boolean>>("/library"),

  /** Reset the taste profile (traits + recommendations); keeps the library. */
  clearProfile: () => del<Record<string, number | boolean>>("/profile"),

  /** Delete ALL of the current user's app data (library, profile, recs, stored key). */
  deleteAccount: () => del<Record<string, number | boolean>>("/account"),
};

/** Shared SWR key for the API-key status (settings page + any gating UI). */
export const API_KEY_STATUS_KEY = "api-key-status";

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
export const USER_PROFILE_KEY = "user-profile";
