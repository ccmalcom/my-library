/**
 * Typed fetch client for the MyLibrary FastAPI backend.
 * All requests go to NEXT_PUBLIC_API_URL (default: http://127.0.0.1:8000).
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

// ─── Types ──────────────────────────────────────────────────────────────────

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
  confidence_label: string | null;
  resolution_confidence: number | null;
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

export interface FeedbackRequest {
  status: "accepted" | "rejected" | "already_read";
  user_note?: string;
}

/** In-app re-rate / review of a library book (PATCH /books/{id}/feedback). */
export interface BookFeedbackRequest {
  /** 1-5 to set, 0 to clear the in-app rating, omit to leave unchanged. */
  rating?: number;
  /** Review text to set; omit to leave unchanged. */
  review?: string;
  /** Remove an existing review. */
  clear_review?: boolean;
}

/** Summary returned by PATCH /books/{id}/feedback (not a full Book). */
export interface BookFeedbackResult {
  id: number;
  title: string;
  author: string | null;
  app_rating: number | null;
  goodreads_rating: number;
  effective_rating: number | null;
  app_review: string | null;
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

/**
 * Shared SWR key for the profile-status query, so any mutation (a re-rate/review)
 * can revalidate the re-profile banner via `mutate(PROFILE_STATUS_KEY)`.
 */
export const PROFILE_STATUS_KEY = "profile-status";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PATCH ${path} → ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

// ─── API calls ──────────────────────────────────────────────────────────────

export const api = {
  stats: () => get<Stats>("/stats"),

  health: () => get<{ status: string; books: number; anthropic_key_set: boolean }>("/health"),

  books: (params?: { shelf?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.shelf) qs.set("shelf", params.shelf);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return get<Book[]>(`/books${query ? `?${query}` : ""}`);
  },

  recommendations: () => get<Recommendation[]>("/recommendations"),

  profile: () => get<Trait[]>("/profile"),

  runRecommend: (n = 10) => post<Record<string, unknown>>("/recommend", { n }),

  feedback: (recId: number, req: FeedbackRequest) =>
    patch<Recommendation>(`/recommendations/${recId}/feedback`, req),

  /** Re-rate and/or review a library book. */
  setBookFeedback: (bookId: number, req: BookFeedbackRequest) =>
    patch<BookFeedbackResult>(`/books/${bookId}/feedback`, req),

  /** Is the taste profile stale relative to recent rating/review edits? */
  profileStatus: () => get<ProfileStatus>("/profile/status"),

  /** Incrementally refresh the taste profile from recent edits only. */
  updateProfile: () => post<Record<string, unknown>>("/profile/update"),
};
