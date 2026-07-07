from mylibrary import directive, profile
from mylibrary.config import LOCAL_USER_ID
from mylibrary.db import session_scope


def test_feedback_block_renders_directive():
    block = profile._feedback_block({"directive_text": "More nonfiction. No grimdark."})
    assert "custom instructions" in block.lower()
    assert "No grimdark." in block


def test_feedback_block_empty_still_empty():
    assert profile._feedback_block({}) == ""
    assert profile._feedback_block(None) == ""


def test_feedback_context_includes_directive():
    directive.set_directive("Prefer literary fiction.", user_id=LOCAL_USER_ID)
    with session_scope() as s:
        ctx = profile._feedback_context(s, LOCAL_USER_ID)
    assert ctx["directive_text"] == "Prefer literary fiction."
