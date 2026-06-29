"""Minimal eval baseline: recommender recall/precision@k on held-out loved books,
plus trait groundedness. Establishes a measurable before/after for the feedback build.
Results are written to data/eval/ (gitignored)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .config import LOCAL_USER_ID

RESULTS_DIR = Path("data/eval")


def write_snapshot(results: dict) -> str:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RESULTS_DIR / f"results_{stamp}.json"
    path.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    return str(path)


def run_eval(
    *,
    k: int = 10,
    holdout: int = 5,
    seed: int = 1234,
    judge: bool = False,
    user_id: str = LOCAL_USER_ID,
) -> dict:
    """Run recall + groundedness evals and return a combined result dict."""
    from .db import session_scope

    with session_scope() as session:
        recall = holdout_recall(
            session, k=k, holdout=holdout, seed=seed, user_id=user_id
        )
        grnd = groundedness(session, user_id=user_id, judge=judge)

    n_traits = len(grnd["per_trait"])

    results = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "params": {"k": k, "holdout": holdout, "seed": seed, "judge": judge},
        "metrics": {
            "recall_at_k": recall["recall_at_k"],
            "precision_at_k": recall["precision_at_k"],
            "groundedness_score": grnd["score"],
            "n_candidates": recall["n_candidates"],
            "n_traits": n_traits,
            "hits": recall["hits"],
        },
    }
    return results


def format_summary(results: dict) -> str:
    """Return a human-readable summary of eval results."""
    p = results.get("params", {})
    m = results.get("metrics", {})
    k = p.get("k", "?")
    holdout = p.get("holdout", "?")
    seed = p.get("seed", "?")

    hits = m.get("hits", [])
    hits_str = ", ".join(hits) if hits else "(none)"

    n_traits = m.get("n_traits", 0)
    grnd_score = m.get("groundedness_score", 0.0)
    grnd_passed = round(grnd_score * n_traits)

    lines = [
        f"Eval baseline  (k={k}, holdout={holdout}, seed={seed})",
        f"  recall@{k}:       {m.get('recall_at_k', 0.0):.3f}",
        f"  precision@{k}:    {m.get('precision_at_k', 0.0):.3f}",
        f"  groundedness:    {grnd_score:.3f}  ({grnd_passed}/{n_traits} traits)",
        f"  candidates:      {m.get('n_candidates', 0)}",
        f"  hits:            {hits_str}",
    ]
    return "\n".join(lines)


def format_compare(curr: dict, prior: dict) -> str:
    """Return a diff string comparing curr metrics to prior metrics."""
    curr_m = curr.get("metrics", {})
    prior_m = prior.get("metrics", {})

    # Define which metrics to compare and their display labels
    metric_labels = [
        ("recall_at_k", "recall@k"),
        ("precision_at_k", "precision@k"),
        ("groundedness_score", "groundedness"),
        ("n_candidates", "candidates"),
        ("n_traits", "n_traits"),
    ]

    lines = ["Metric delta (current vs prior):"]
    for key, label in metric_labels:
        if key not in curr_m and key not in prior_m:
            continue
        curr_val = curr_m.get(key, 0)
        prior_val = prior_m.get(key, 0)
        if isinstance(curr_val, float) or isinstance(prior_val, float):
            delta = float(curr_val) - float(prior_val)
            if delta == 0.0:
                delta_str = "(unchanged)"
            elif delta > 0:
                delta_str = f"(+{delta:.3f})"
            else:
                delta_str = f"({delta:.3f})"
            lines.append(f"  {label:<16} {prior_val:.3f} → {curr_val:.3f}  {delta_str}")
        else:
            delta = int(curr_val) - int(prior_val)
            if delta == 0:
                delta_str = "(unchanged)"
            elif delta > 0:
                delta_str = f"(+{delta})"
            else:
                delta_str = f"({delta})"
            lines.append(f"  {label:<16} {prior_val} → {curr_val}  {delta_str}")

    return "\n".join(lines)


def load_snapshot(path: str) -> dict:
    """Load a JSON snapshot from the given path."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"Eval snapshot not found: {path}\n"
            f"Run 'python -m mylibrary.cli eval' to generate one."
        )
    return json.loads(p.read_text())


def groundedness(
    session,
    *,
    user_id: str = LOCAL_USER_ID,
    judge: bool = False,
    api_key: str | None = None,
) -> dict:
    """Deterministic groundedness check for all TasteTrait rows for a user.

    Each trait is tested against four rules:
    1. claim is non-empty after strip.
    2. All ids in exhibits and contrasts are valid book ids for the user.
    3. exhibits and contrasts are disjoint.
    4. Polarity consistency:
       - "aversion" -> every exhibits book has effective_rating <= 3 (and rated).
       - "reward"   -> every exhibits book has effective_rating >= 4 (and rated).

    Returns:
        {
          "per_trait": [{"trait_id": int, "passed": bool, "reasons": [str, ...]}],
          "score": float  # fraction of traits that pass all checks
        }

    The judge=True path (Claude-scored coherence) is not yet implemented.
    """
    if judge:
        raise NotImplementedError("judge not yet wired")

    from .db import Book, TasteTrait

    # Fetch all valid book ids for this user once (set for O(1) lookup).
    valid_ids: set[int] = {
        row[0]
        for row in session.query(Book.id).filter(Book.user_id == user_id).all()
    }

    # Map book_id -> effective_rating for books we'll need to inspect.
    # We load lazily below only for books referenced by traits.
    def _rating(book_id: int) -> int | None:
        book = session.get(Book, book_id)
        if book is None:
            return None
        return book.effective_rating

    traits = (
        session.query(TasteTrait)
        .filter(TasteTrait.user_id == user_id)
        .all()
    )

    per_trait = []
    for trait in traits:
        reasons: list[str] = []
        exhibits: list[int] = trait.exhibits or []
        contrasts: list[int] = trait.contrasts or []

        # Rule 1: non-empty claim
        if not (trait.claim or "").strip():
            reasons.append("claim is empty")

        # Rule 2: all referenced ids are valid books for this user
        all_ids = set(exhibits) | set(contrasts)
        invalid = all_ids - valid_ids
        if invalid:
            reasons.append(f"invalid book ids: {sorted(invalid)}")

        # Rule 3: exhibits and contrasts must be disjoint
        overlap = set(exhibits) & set(contrasts)
        if overlap:
            reasons.append(f"exhibits/contrasts overlap on book ids: {sorted(overlap)}")

        # Rule 4: polarity consistency (only check ids that ARE valid)
        if trait.polarity in ("aversion", "reward"):
            for bid in exhibits:
                if bid not in valid_ids:
                    continue  # already flagged in rule 2; skip to avoid duplicate noise
                rating = _rating(bid)
                if trait.polarity == "aversion":
                    if rating is None or rating > 3:
                        reasons.append(
                            f"polarity 'aversion' but book {bid} has rating {rating!r} (need <= 3)"
                        )
                elif trait.polarity == "reward":
                    if rating is None or rating < 4:
                        reasons.append(
                            f"polarity 'reward' but book {bid} has rating {rating!r} (need >= 4)"
                        )

        per_trait.append({
            "trait_id": trait.id,
            "passed": len(reasons) == 0,
            "reasons": reasons,
        })

    n = len(per_trait)
    score = sum(1 for t in per_trait if t["passed"]) / n if n > 0 else 1.0

    return {"per_trait": per_trait, "score": score}


def holdout_recall(
    session,
    *,
    k: int,
    holdout: int,
    seed: int,
    user_id: str = LOCAL_USER_ID,
) -> dict:
    """Offline recall/precision@k using held-out loved books as the target set.

    Selects `holdout` loved books (effective_rating >= 4) via seeded RNG, masks
    them from the signal so stage-1 retrieval can resurface them, then counts hits
    by exact key match OR neighbor (same author surname OR >=2 shared subjects).
    No Claude calls — seed_pool=[] so this is free and deterministic.

    Returns:
        {
          "k": int,
          "holdout": int,
          "seed": int,
          "recall_at_k": float,   # hits / holdout
          "precision_at_k": float, # hits / min(k, n_candidates)
          "hits": [title, ...],   # titles of held-out books that were retrieved
          "n_candidates": int,
        }
    """
    import random

    from . import recommend
    from .db import Book
    from .enrich import _normalize_title, _surname

    # Step 1: Build full signal.
    signal = recommend._build_signal(session, user_id)

    # Step 2: Seeded-random select `holdout` loved books.
    rng = random.Random(seed)
    loved_all = signal["loved"]  # list of dicts, already filtered to rating >= LOVED_MIN
    # Clamp holdout to however many loved books actually exist.
    n_holdout = min(holdout, len(loved_all))
    held_out = rng.sample(loved_all, n_holdout)

    # Build a lookup from book id -> loved dict for subject access.
    held_ids = {d["id"] for d in held_out}

    # Also need ISBNs of held-out books so we can remove them from library_isbns.
    # Fetch from DB since the signal dict doesn't carry isbn13.
    held_books_db: dict[int, Book] = {}
    if held_ids:
        rows = session.query(Book).filter(Book.id.in_(held_ids)).all()
        held_books_db = {b.id: b for b in rows}

    # Step 3: Build masked signal — remove held-out books so retrieval may resurface them.
    masked_loved = [d for d in loved_all if d["id"] not in held_ids]
    masked_keys = set(signal["library_keys"])
    masked_isbns = set(signal["library_isbns"])
    for d in held_out:
        key = (_normalize_title(d["title"]), _surname(d["author"] or ""))
        masked_keys.discard(key)
        b = held_books_db.get(d["id"])
        if b and b.isbn13:
            masked_isbns.discard(b.isbn13)

    masked_signal = {
        **signal,
        "loved": masked_loved,
        "library_keys": masked_keys,
        "library_isbns": masked_isbns,
    }

    # Step 4: Stage-1 retrieval only — no Claude calls (seed_pool=[]).
    metadata_pool = recommend._metadata_pool(masked_signal, per_query=5)
    candidates = recommend._assemble(metadata_pool, [], masked_signal, cap=200)

    # Consider only the top-k candidates for precision.
    candidates_k = candidates[:k]

    # Step 5: Count hits.
    hits: list[str] = []
    for held in held_out:
        held_key = (_normalize_title(held["title"]), _surname(held["author"] or ""))
        held_subjects = set(held.get("subjects") or [])
        held_surname = held_key[1]

        matched = False
        for cand in candidates_k:
            cand_key = (_normalize_title(cand.get("title") or ""), _surname(cand.get("author") or ""))
            # Exact key match
            if cand_key == held_key:
                matched = True
                break
            # Neighbor: same author surname
            if cand_key[1] and cand_key[1] == held_surname:
                matched = True
                break
            # Neighbor: >=2 shared subjects
            cand_subjects = set(cand.get("subjects") or [])
            if len(cand_subjects & held_subjects) >= 2:
                matched = True
                break

        if matched:
            hits.append(held["title"])

    n_candidates = len(candidates)
    denominator_precision = min(k, n_candidates)

    return {
        "k": k,
        "holdout": n_holdout,
        "seed": seed,
        "recall_at_k": len(hits) / n_holdout if n_holdout > 0 else 0.0,
        "precision_at_k": min(1.0, len(hits) / denominator_precision) if denominator_precision > 0 else 0.0,
        "hits": hits,
        "n_candidates": n_candidates,
    }
