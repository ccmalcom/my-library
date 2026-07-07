from unittest.mock import patch

from fastapi.testclient import TestClient

from mylibrary.api import app

client = TestClient(app)


def test_get_directive_empty():
    r = client.get("/directive")
    assert r.status_code == 200
    assert r.json() == {"nl_text": None, "constraints": {}, "updated_at": None}


def test_put_then_get_directive():
    r = client.put("/directive", json={"nl_text": "More translated fiction.",
                                       "constraints": {"languages": ["en"]}})
    assert r.status_code == 200
    body = r.json()
    assert body["nl_text"] == "More translated fiction."
    assert body["constraints"] == {"languages": ["en"]}

    r2 = client.get("/directive")
    assert r2.json()["nl_text"] == "More translated fiction."


def test_put_empty_is_422():
    r = client.put("/directive", json={"nl_text": "  ", "constraints": {}})
    assert r.status_code == 422


def test_delete_directive():
    client.put("/directive", json={"nl_text": "temp", "constraints": {}})
    r = client.delete("/directive")
    assert r.status_code == 200
    assert r.json()["nl_text"] is None
    assert client.get("/directive").json()["nl_text"] is None


def test_draft_endpoint_returns_proposal():
    fake = {
        "proposed_text": "Lean literary, no grimdark.",
        "constraints": {"exclude_subjects": ["grimdark"]},
        "conflicts": [],
        "assistant_message": "Captured. Any language preference?",
    }
    with patch("mylibrary.api.distill_directive", return_value=fake):
        r = client.post("/directive/draft", json={"message": "deep characters, no grimdark"})
    assert r.status_code == 200
    body = r.json()
    assert body["proposed_text"] == "Lean literary, no grimdark."
    assert body["constraints"] == {"exclude_subjects": ["grimdark"]}
    assert body["assistant_message"].startswith("Captured")
