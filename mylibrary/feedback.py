"""Beta-feedback service layer.

Handles submit, eligibility check, and dismiss for the in-app feedback prompts.
All functions are user-scoped (user_id is always the first argument).

Triggers:
  - post-setup           one-time, shown after the setup wizard completes
  - post-first-profile   one-time, shown after the first taste profile is built
  - post-recs            repeatable, shown after each recommend run
  - None / general       user manually opened the feedback modal

State flow:
  ask_later -> submitted | dont_ask
  (no state) -> submitted | dont_ask | ask_later
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .config import get_settings
from .db import Feedback, FeedbackPromptState, session_scope, utcnow

# Triggers that fire exactly once per user (keyed on run_id='').
ONE_TIME_TRIGGERS = {"post-setup", "post-first-profile"}
# Trigger that fires once per recommend run.
REPEATABLE_TRIGGER = "post-recs"

VALID_CATEGORIES = {"bug", "idea", "confusing", "praise", "targeted"}


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------

def submit_feedback(
    user_id: str,
    *,
    category: str,
    body: str,
    trigger: str | None = None,
    run_id: str | None = None,
    page: str | None = None,
    app_version: str | None = None,
) -> None:
    """Insert a Feedback row and (when appropriate) update FeedbackPromptState.

    One-time triggers (post-setup, post-first-profile):
        upsert FeedbackPromptState to status='submitted', run_id=''

    post-recs trigger:
        do NOT write a state row — the feedback row itself is the per-run signal.

    Null / general trigger:
        no state row at all.
    """
    with session_scope() as s:
        fb = Feedback(
            user_id=user_id,
            category=category,
            body=body,
            trigger=trigger,
            run_id=run_id or None,
            page=page,
            app_version=app_version,
        )
        s.add(fb)

        if trigger in ONE_TIME_TRIGGERS:
            _upsert_state(s, user_id=user_id, trigger=trigger, run_id="", status="submitted")


# ---------------------------------------------------------------------------
# eligibility
# ---------------------------------------------------------------------------

def check_prompt_eligibility(
    user_id: str,
    *,
    trigger: str,
    run_id: str | None = None,
) -> bool:
    """Return True iff the feedback prompt should be shown to user_id.

    Gate: if settings.feedback_prompts_enabled is False, always return False.

    For one-time triggers (post-setup, post-first-profile):
        - No state row           → True
        - ask_later, snooze expired → True
        - ask_later, snooze active  → False
        - submitted or dont_ask     → False

    For post-recs (repeatable):
        True only when ALL of:
        1. No global dont_ask row   (user_id, 'post-recs', run_id='')
        2. No feedback row for run  (user_id, 'post-recs', run_id=run_id)
        3. No active snooze for run (user_id, 'post-recs', run_id=run_id, ask_later, snooze_until > now)
    """
    settings = get_settings()
    if not settings.feedback_prompts_enabled:
        return False

    now = utcnow()

    with session_scope() as s:
        if trigger in ONE_TIME_TRIGGERS:
            return _one_time_eligible(s, user_id=user_id, trigger=trigger, now=now)
        elif trigger == REPEATABLE_TRIGGER:
            return _post_recs_eligible(s, user_id=user_id, run_id=run_id or "", now=now)
        else:
            # Unknown trigger — don't show
            return False


def _one_time_eligible(s, *, user_id: str, trigger: str, now: datetime) -> bool:
    row = (
        s.query(FeedbackPromptState)
        .filter(
            FeedbackPromptState.user_id == user_id,
            FeedbackPromptState.trigger == trigger,
            FeedbackPromptState.run_id == "",
        )
        .one_or_none()
    )
    if row is None:
        return True
    if row.status == "ask_later":
        return row.snooze_until is not None and row.snooze_until <= now
    # submitted or dont_ask
    return False


def _post_recs_eligible(s, *, user_id: str, run_id: str, now: datetime) -> bool:
    # Condition 1: no global dont_ask
    global_dont_ask = (
        s.query(FeedbackPromptState)
        .filter(
            FeedbackPromptState.user_id == user_id,
            FeedbackPromptState.trigger == REPEATABLE_TRIGGER,
            FeedbackPromptState.run_id == "",
            FeedbackPromptState.status == "dont_ask",
        )
        .one_or_none()
    )
    if global_dont_ask is not None:
        return False

    # Condition 2: no submitted feedback for this run
    fb_exists = (
        s.query(Feedback)
        .filter(
            Feedback.user_id == user_id,
            Feedback.trigger == REPEATABLE_TRIGGER,
            Feedback.run_id == run_id,
        )
        .first()
    )
    if fb_exists is not None:
        return False

    # Condition 3: no active snooze for this run
    active_snooze = (
        s.query(FeedbackPromptState)
        .filter(
            FeedbackPromptState.user_id == user_id,
            FeedbackPromptState.trigger == REPEATABLE_TRIGGER,
            FeedbackPromptState.run_id == run_id,
            FeedbackPromptState.status == "ask_later",
            FeedbackPromptState.snooze_until > now,
        )
        .one_or_none()
    )
    if active_snooze is not None:
        return False

    return True


# ---------------------------------------------------------------------------
# dismiss
# ---------------------------------------------------------------------------

def dismiss_prompt(
    user_id: str,
    *,
    trigger: str,
    run_id: str | None = None,
    mode: str,
) -> None:
    """Record the user's dismiss decision.

    dont_ask:
        Upsert to status='dont_ask', run_id='' (global terminal switch).

    ask_later:
        Upsert to status='ask_later', snooze_until = now + snooze_hours.
        run_id='' for one-time triggers; the passed run_id for post-recs.
    """
    settings = get_settings()
    now = utcnow()

    if mode == "dont_ask":
        state_run_id = ""
        snooze_until = None
    elif mode == "ask_later":
        # One-time triggers always use '' for run_id; post-recs uses the caller's run_id.
        if trigger in ONE_TIME_TRIGGERS:
            state_run_id = ""
        else:
            state_run_id = run_id or ""
        snooze_until = now + timedelta(hours=settings.feedback_snooze_hours)
    else:
        raise ValueError(f"Unknown dismiss mode: {mode!r}")

    with session_scope() as s:
        _upsert_state(
            s,
            user_id=user_id,
            trigger=trigger,
            run_id=state_run_id,
            status=mode,
            snooze_until=snooze_until,
        )


# ---------------------------------------------------------------------------
# internal upsert helper
# ---------------------------------------------------------------------------

def _upsert_state(
    s,
    *,
    user_id: str,
    trigger: str,
    run_id: str,
    status: str,
    snooze_until: datetime | None = None,
) -> FeedbackPromptState:
    """Insert or update the (user_id, trigger, run_id) state row."""
    row = (
        s.query(FeedbackPromptState)
        .filter(
            FeedbackPromptState.user_id == user_id,
            FeedbackPromptState.trigger == trigger,
            FeedbackPromptState.run_id == run_id,
        )
        .one_or_none()
    )
    if row is None:
        row = FeedbackPromptState(
            user_id=user_id,
            trigger=trigger,
            run_id=run_id,
            status=status,
            snooze_until=snooze_until,
        )
        s.add(row)
    else:
        row.status = status
        row.snooze_until = snooze_until
    return row
