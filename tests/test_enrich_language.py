from mylibrary.db import Enrichment
from mylibrary import enrich


def test_apply_sets_language():
    enr = Enrichment(book_id=1)
    cand = {"source": "googlebooks", "resolved_id": "x", "subjects": [],
            "language": "en", "raw": {}}
    enrich._apply(enr, cand, "HIGH", "isbn:googlebooks")
    assert enr.language == "en"
