from sqlalchemy import inspect

from mylibrary import db


def test_user_directive_table_exists():
    db.init_db()
    insp = inspect(db._engine)
    assert "user_directive" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("user_directive")}
    assert {"id", "user_id", "nl_text", "constraints", "created_at", "updated_at"} <= cols
