from __future__ import annotations

import json

import pytest

from aegis_worker.cli import main
from aegis_worker.schema import BriefValidationError
from aegis_worker.volume import Volume


def _snapshot(root):
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != ".lock"
    }


def test_ingest_layout_and_manifest(volume_root, sample_dir):
    vol = Volume(volume_root, max_briefs=30)
    m = vol.ingest(sample_dir / "2026-09-02.json")
    assert m == {"retained": ["2026-09-02"], "max_briefs": 30, "last_ingest": "2026-09-02"}
    assert (volume_root / "briefs/2026-09-02/brief.json").is_file()
    assert (volume_root / "briefs/2026-09-02/index.html").is_file()
    assert json.loads((volume_root / "manifest.json").read_text()) == m
    idx = json.loads((volume_root / "archive-index.json").read_text())
    assert idx["generated_from"] == ["2026-09-02"]
    m = vol.ingest(sample_dir / "2026-09-01.json")  # older brief arrives late
    assert m["retained"] == ["2026-09-01", "2026-09-02"] and m["last_ingest"] == "2026-09-01"
    assert not list(volume_root.rglob(".tmp-*"))


def test_retention_prunes_to_max_briefs(volume_root, sample_dir):
    vol = Volume(volume_root, max_briefs=5)
    files = sorted(sample_dir.glob("*.json"))
    for f in files:
        vol.ingest(f)
    m = vol.read_manifest()
    expected = sorted(f.stem for f in files)[-5:]
    assert m["retained"] == expected
    assert vol.dates() == expected
    assert sorted(p.name for p in (volume_root / "briefs").iterdir()) == expected
    assert json.loads((volume_root / "archive-index.json").read_text())["generated_from"] == expected
    # an old brief arriving now is stored, then pruned immediately
    m = vol.ingest(sample_dir / "2026-09-01.json")
    assert m["retained"] == expected and m["last_ingest"] == "2026-09-01"


def test_reingest_replaces_in_place(volume_root, samples):
    vol = Volume(volume_root)
    vol.ingest(samples["2026-09-29"])
    changed = dict(samples["2026-09-29"])
    changed["threat_level"] = "CRITICAL"
    m = vol.ingest(changed)
    assert m["retained"] == ["2026-09-29"]
    assert vol.read_brief("2026-09-29")["threat_level"] == "CRITICAL"
    assert "CRITICAL" in vol.read_html("2026-09-29")


def test_invalid_brief_writes_nothing(volume_root, samples):
    vol = Volume(volume_root)
    bad = samples["2026-09-29"]
    del bad["items"]
    with pytest.raises(BriefValidationError):
        vol.ingest(bad)
    assert vol.is_empty() and not (volume_root / "manifest.json").exists()


def test_batch_one_by_one_and_rebuild_are_byte_identical(tmp_path, sample_dir):
    a, b = Volume(tmp_path / "a", 10), Volume(tmp_path / "b", 10)
    a.ingest_many(sorted(sample_dir.glob("*.json"), reverse=True))
    for f in sorted(sample_dir.glob("*.json")):
        b.ingest(f)
    assert _snapshot(a.root) == _snapshot(b.root)
    before = _snapshot(a.root)
    (a.root / "archive-index.json").unlink()
    (a.root / "briefs/2026-09-29/index.html").write_text("stale")
    a.rebuild()
    assert _snapshot(a.root) == before


def test_replay_step_ingests_in_date_order(volume_root, sample_dir, monkeypatch, capsys):
    monkeypatch.setenv("VOLUME_ROOT", str(volume_root))
    monkeypatch.setenv("MAX_BRIEFS", "30")
    order = sorted(f.stem for f in sample_dir.glob("*.json"))
    seen = []
    for _ in range(4):
        assert main(["replay", str(sample_dir), "--step"]) == 0
        out = capsys.readouterr().out
        seen.append(out.split("ingested ")[1].split(" ")[0])
    assert seen == order[:4]
    assert Volume(volume_root).dates() == order[:4]
    assert main(["replay", str(sample_dir)]) == 0
    capsys.readouterr()
    assert Volume(volume_root).dates() == order
    assert main(["replay", str(sample_dir), "--step"]) == 0
    assert "nothing to do" in capsys.readouterr().out


def test_cli_ingest_dir_if_empty_and_errors(volume_root, sample_dir, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("VOLUME_ROOT", str(volume_root))
    assert main(["ingest-dir", str(sample_dir), "--if-empty"]) == 0
    assert len(Volume(volume_root).dates()) == 22
    assert main(["ingest-dir", str(sample_dir), "--if-empty"]) == 0
    assert "skipping seed" in capsys.readouterr().out
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"date": "2026-10-01", "items": []}))
    assert main(["ingest", str(bad)]) == 1
    assert "failed schema validation" in capsys.readouterr().err
    assert main(["rebuild"]) == 0
