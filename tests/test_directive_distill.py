from unittest.mock import MagicMock, patch

from mylibrary import directive
from mylibrary.config import LOCAL_USER_ID


def _fake_tool_message(payload: dict):
    block = MagicMock()
    block.type = "tool_use"
    block.input = payload
    msg = MagicMock()
    msg.content = [block]
    return msg


def test_distill_parses_and_cleans():
    payload = {
        "proposed_text": "Lean into character-driven literary fiction. No grimdark.",
        "constraints": {"exclude_subjects": ["Grimdark", " "], "max_pages": 400},
        "conflicts": ["You rejected 'rewards fast-paced plots' but ask for thrillers", ""],
        "assistant_message": "Got it. Anything on length?",
    }
    with patch.object(directive, "resolve_anthropic_key", return_value="sk-test"), \
         patch.object(directive, "tracked_create", return_value=_fake_tool_message(payload)), \
         patch.object(directive, "Anthropic", return_value=MagicMock()):
        out = directive.distill_directive("I like deep characters, no grimdark", user_id=LOCAL_USER_ID)
    assert out["proposed_text"].startswith("Lean into")
    assert out["constraints"] == {"exclude_subjects": ["grimdark"]}   # max_pages dropped
    assert out["conflicts"] == ["You rejected 'rewards fast-paced plots' but ask for thrillers"]
    assert out["assistant_message"] == "Got it. Anything on length?"


def test_distill_requires_api_key():
    import pytest
    with patch.object(directive, "resolve_anthropic_key", return_value=None):
        with pytest.raises(RuntimeError):
            directive.distill_directive("anything", user_id=LOCAL_USER_ID)
