from __future__ import annotations

import pytest

from aegis_worker.schema import BriefValidationError, parse_brief, validate_brief


def test_all_samples_validate(samples):
    assert len(samples) == 22
    for date, data in samples.items():
        validate_brief(data)
        b = parse_brief(data)
        assert b.date == date
        assert all(i.areas for i in b.items)


def test_malformed_brief_rejected_with_first_five_problems(samples):
    bad = samples["2026-09-29"]
    del bad["run"]
    bad["date"] = "29/09/2026"
    bad["items"][0]["tier"] = 7
    bad["items"][0]["areas"] = []
    bad["items"][1]["tlp"] = "purple"
    bad["items"][2]["score"] = 101
    bad["items"][3]["kind"] = "rumour"
    with pytest.raises(BriefValidationError) as ei:
        validate_brief(bad)
    err = ei.value
    assert len(err.problems) == 5
    assert err.total >= 7
    assert "more" in str(err)
    assert all(p.startswith("$") for p in err.problems)


def test_impossible_calendar_date_rejected(samples):
    bad = samples["2026-09-29"]
    bad["date"] = "2026-02-30"
    with pytest.raises(BriefValidationError, match="not a valid calendar date"):
        validate_brief(bad)


def test_non_object_rejected():
    with pytest.raises(BriefValidationError):
        validate_brief([1, 2, 3])


def test_defaults_match_web_normalization(samples):
    data = samples["2026-09-29"]
    data.pop("outstanding")
    data.pop("banners")
    it = data["items"][0]
    for k in ("attack", "indicators", "recommended_actions", "score_parts"):
        it.pop(k, None)
    b = parse_brief(data)
    assert b.outstanding == [] and b.banners == []
    assert b.items[0].indicators == [] and b.items[0].score_parts == {}
