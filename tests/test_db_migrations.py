"""Tests for db.py lightweight migrations — column add-in-place safety."""
# Top-level import ensures load_dotenv() fires before the isolated_db conftest
# fixture runs monkeypatch.delenv("DATABASE_URL"). Without this, load_dotenv
# runs *after* the delenv (no-op) during fixture setup, leaving DATABASE_URL
# set and causing init_db to target Postgres instead of the test SQLite file.
import mylibrary.db as _db  # noqa: F401 - side-effect import
import pytest
from sqlalchemy import text as sa_text, inspect


def test_taste_traits_adds_user_weight_in_place(tmp_path, monkeypatch):
    """init_db() must add user_weight + verdict_updated_at to an existing
    taste_traits table WITHOUT dropping it or losing existing rows.

    Strategy: let the autouse isolated_db fixture create the full schema first,
    then downgrade taste_traits to the old schema (drop new columns via
    rename-create-copy-drop), insert a sentinel row, call init_db() again.
    """
    import mylibrary.db as db

    # isolated_db already ran init_db() with MYLIBRARY_DATA_DIR=tmp_path and
    # DATABASE_URL unset, so db._engine must be a SQLite engine.
    assert "sqlite" in str(db._engine.url), (
        "Expected SQLite engine but got: " + str(db._engine.url)
    )

    # Downgrade taste_traits to old schema (without user_weight / verdict_updated_at).
    # SQLite does not support DROP COLUMN directly so we use rename-create-copy-drop.
    with db._engine.begin() as conn:
        conn.execute(sa_text(
            "ALTER TABLE taste_traits RENAME TO taste_traits_old"
        ))
        conn.execute(sa_text(
            "CREATE TABLE taste_traits ("
            "    id INTEGER PRIMARY KEY,"
            "    user_id VARCHAR NOT NULL DEFAULT 'local',"
            "    claim TEXT NOT NULL,"
            "    polarity VARCHAR,"
            "    exhibits JSON,"
            "    contrasts JSON,"
            "    inference_confidence FLOAT DEFAULT 0.0,"
            "    status VARCHAR DEFAULT 'proposed',"
            "    user_note TEXT,"
            "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
            ")"
        ))
        conn.execute(sa_text(
            "INSERT INTO taste_traits"
            "  (id, user_id, claim, polarity, exhibits, contrasts,"
            "   inference_confidence, status, user_note, created_at)"
            " SELECT id, user_id, claim, polarity, exhibits, contrasts,"
            "        inference_confidence, status, user_note, created_at"
            " FROM taste_traits_old"
        ))
        conn.execute(sa_text("DROP TABLE taste_traits_old"))
        # Insert sentinel row to verify data survives the migration.
        conn.execute(sa_text(
            "INSERT INTO taste_traits (claim, polarity, exhibits, contrasts)"
            " VALUES ('Loves fantasy', 'reward', '[]', '[]')"
        ))

    # Confirm new columns are absent before running init_db() again.
    cols_before = {c["name"] for c in inspect(db._engine).get_columns("taste_traits")}
    assert "user_weight" not in cols_before, "user_weight should not exist yet"
    assert "verdict_updated_at" not in cols_before, "verdict_updated_at should not exist yet"

    # Reset the engine so init_db() re-opens the same SQLite file fresh.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db._engine.dispose()
    db._engine = None
    db._SessionLocal = None
    db.init_db()

    # Verify the new columns were added and the sentinel row survived.
    with db._engine.connect() as conn:
        cols = {c["name"] for c in inspect(db._engine).get_columns("taste_traits")}
        assert "user_weight" in cols, "user_weight column missing after init_db"
        assert "verdict_updated_at" in cols, "verdict_updated_at column missing after init_db"
        row = conn.execute(sa_text(
            "SELECT claim, user_weight FROM taste_traits"
        )).fetchone()
        assert row is not None, "Existing row was deleted -- migration must preserve data"
        assert row[0] == "Loves fantasy"
        assert float(row[1]) == 1.0, "Expected user_weight=1.0 default, got " + str(row[1])


def test_rec_reject_reasons_migration(tmp_path, monkeypatch):
    """init_db() must add reject_reasons to an existing recommendations table
    WITHOUT dropping it or losing existing rows.

    Strategy: downgrade recommendations to an old schema (has run_id + status
    but NOT reject_reasons), insert a sentinel row, call init_db() again.
    """
    import mylibrary.db as db

    assert "sqlite" in str(db._engine.url), (
        "Expected SQLite engine but got: " + str(db._engine.url)
    )

    # Downgrade recommendations to old schema (missing reject_reasons).
    with db._engine.begin() as conn:
        conn.execute(sa_text(
            "ALTER TABLE recommendations RENAME TO recommendations_old"
        ))
        conn.execute(sa_text(
            "CREATE TABLE recommendations ("
            "    id INTEGER PRIMARY KEY,"
            "    user_id VARCHAR NOT NULL DEFAULT 'local',"
            "    run_id VARCHAR NOT NULL,"
            "    rank INTEGER,"
            "    title VARCHAR NOT NULL,"
            "    author VARCHAR,"
            "    year INTEGER,"
            "    isbn13 VARCHAR,"
            "    cover_url VARCHAR,"
            "    subjects JSON,"
            "    description TEXT,"
            "    catalog_source VARCHAR,"
            "    catalog_id VARCHAR,"
            "    retrieval_pool VARCHAR,"
            "    seed_reason VARCHAR,"
            "    score FLOAT DEFAULT 0.0,"
            "    rationale TEXT,"
            "    grounded_trait_ids JSON,"
            "    grounded_book_ids JSON,"
            "    status VARCHAR DEFAULT 'served',"
            "    user_note TEXT,"
            "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
            ")"
        ))
        conn.execute(sa_text(
            "INSERT INTO recommendations"
            "  (run_id, rank, title, status)"
            " VALUES ('run-001', 1, 'Test Book', 'rejected')"
        ))
        conn.execute(sa_text("DROP TABLE recommendations_old"))

    # Confirm reject_reasons is absent before running init_db() again.
    cols_before = {c["name"] for c in inspect(db._engine).get_columns("recommendations")}
    assert "reject_reasons" not in cols_before, "reject_reasons should not exist yet"

    # Reset the engine so init_db() re-opens the same SQLite file fresh.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db._engine.dispose()
    db._engine = None
    db._SessionLocal = None
    db.init_db()

    # Verify the new column was added and the sentinel row survived.
    with db._engine.connect() as conn:
        cols = {c["name"] for c in inspect(db._engine).get_columns("recommendations")}
        assert "reject_reasons" in cols, "reject_reasons column missing after init_db"
        row = conn.execute(sa_text(
            "SELECT title, status FROM recommendations WHERE run_id = 'run-001'"
        )).fetchone()
        assert row is not None, "Existing row was deleted -- migration must preserve data"
        assert row[0] == "Test Book"
        assert row[1] == "rejected"


def test_feedback_vocab_validates():
    from mylibrary.feedback_vocab import is_valid_reasons, REJECT_REASONS
    assert is_valid_reasons(["too_dark"])
    assert is_valid_reasons(list(REJECT_REASONS))
    assert not is_valid_reasons(["nonsense"])
    assert not is_valid_reasons([])


def test_init_db_creates_taste_signal(tmp_path, monkeypatch):
    """init_db() must create the taste_signal table and allow inserting rows."""
    import mylibrary.db as db

    assert "sqlite" in str(db._engine.url), (
        "Expected SQLite engine but got: " + str(db._engine.url)
    )

    # Table should exist after init_db() (already called by isolated_db fixture).
    insp = inspect(db._engine)
    assert "taste_signal" in insp.get_table_names(), "taste_signal table missing after init_db"

    # Insert a more/book row and a less/rec row, then read them back.
    with db._engine.begin() as conn:
        conn.execute(sa_text(
            "INSERT INTO taste_signal (user_id, direction, target_kind, target_book_id, snapshot)"
            " VALUES ('local', 'more', 'book', 42, NULL)"
        ))
        conn.execute(sa_text(
            "INSERT INTO taste_signal (user_id, direction, target_kind, target_book_id, snapshot)"
            " VALUES ('local', 'less', 'rec', NULL, '{\"title\": \"Some Rec\"}')"
        ))

    with db._engine.connect() as conn:
        rows = conn.execute(sa_text(
            "SELECT direction, target_kind, target_book_id FROM taste_signal ORDER BY id"
        )).fetchall()

    assert len(rows) == 2
    assert rows[0] == ("more", "book", 42)
    assert rows[1][0] == "less"
    assert rows[1][1] == "rec"
    assert rows[1][2] is None


def test_taste_signal_survives_clear_library_and_clear_profile(tmp_path, monkeypatch):
    """clear_library() and clear_profile() must NOT drop taste_signal rows."""
    import mylibrary.db as db
    from mylibrary.purge import clear_library, clear_profile

    assert "sqlite" in str(db._engine.url), (
        "Expected SQLite engine but got: " + str(db._engine.url)
    )

    # Insert a TasteSignal row directly via SQL.
    with db._engine.begin() as conn:
        conn.execute(sa_text(
            "INSERT INTO taste_signal (user_id, direction, target_kind)"
            " VALUES ('local', 'more', 'book')"
        ))

    # Verify row is present.
    with db._engine.connect() as conn:
        count_before = conn.execute(
            sa_text("SELECT COUNT(*) FROM taste_signal")
        ).scalar()
    assert count_before == 1, "Setup: expected 1 taste_signal row before purge"

    # clear_profile drops traits/recs/profile_meta — taste_signal must survive.
    clear_profile(user_id="local")

    with db._engine.connect() as conn:
        count_after_profile = conn.execute(
            sa_text("SELECT COUNT(*) FROM taste_signal")
        ).scalar()
    assert count_after_profile == 1, (
        "clear_profile() dropped taste_signal rows — must NOT happen"
    )

    # clear_library cascades to clear_profile AND drops books — taste_signal must still survive.
    clear_library(user_id="local")

    with db._engine.connect() as conn:
        count_after_library = conn.execute(
            sa_text("SELECT COUNT(*) FROM taste_signal")
        ).scalar()
    assert count_after_library == 1, (
        "clear_library() dropped taste_signal rows — must NOT happen"
    )

    # Confirm taste_signal table still exists (not dropped by any path).
    insp = inspect(db._engine)
    assert "taste_signal" in insp.get_table_names(), (
        "taste_signal table was dropped during purge operations"
    )
