from __future__ import annotations

import re

import pytest
from conftest import DASHBOARD

from aegis_worker.index import build_index
from aegis_worker.render import TEMPLATES, defang, render_brief, safe_url


@pytest.fixture
def index(samples):
    return build_index(samples)


def test_render_is_byte_identical_across_runs(samples, index):
    for date, data in samples.items():
        a = render_brief(data, index)
        b = render_brief(dict(reversed(list(data.items()))), build_index(samples))
        assert a.encode() == b.encode(), date


def test_page_structure(samples, index):
    html = render_brief(samples["2026-09-29"], index)
    assert html.startswith("<!doctype html>")
    assert 'SU InfoSec<span class="pipe">|</span>AEGIS Daily Brief' in html
    assert "border-bottom:3px solid var(--su-orange)" in html
    assert 'Syracuse University <span class="accent">Information Security</span>' in html
    assert '<span class="pill new">Today</span>' in html
    assert html.count('<article class="item t1"') == 1  # tier 1 expanded
    assert html.count('<details class="item t2"') == 10  # tier 2 collapsed rows
    assert html.count('<details class="item t3"') == 8
    assert "Tier 1 · Action required" in html and "Tier 3 · Informational" in html
    assert "Exposure register" in html and "Watchlist" in html and "Brief sections" in html
    assert "archive 22 days" in html
    assert "<script" not in html


def test_invalid_run_shows_validity_banner(samples, index):
    data = samples["2026-09-29"]
    data["run"]["valid"] = False
    html = render_brief(data, index)
    assert "This brief failed schema validation" in html


def test_xss_is_escaped(samples, index):
    data = samples["2026-09-29"]
    data["items"][0]["title"] = '<script>alert("x")</script>'
    data["items"][1]["description"] = "<img src=x onerror=alert(1)>"
    data["context"]["geopolitical"] = [{"t": "<b>bold</b>", "d": "a & b", "s": "'q'"}]
    data["notes"] = {"<x>": "</pre><script>1</script>"}
    data["items"][0]["source"]["url"] = "javascript:alert(1)"
    html = render_brief(data, index)
    assert "<script>" not in html
    assert "&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;" in html
    assert "&lt;img src=x onerror=alert(1)&gt;" in html
    assert "&lt;b&gt;bold&lt;/b&gt;" in html
    assert "javascript:" not in html


def test_indicators_defanged_and_never_links(samples, index):
    data = samples["2026-09-29"]
    data["items"][0]["indicators"] = [
        ["url", "http://evil.example.com/x.php"],
        ["domain", "bad.example.org"],
        ["ipv4", "203.0.113.7"],
    ]
    data["items"][3]["indicators"] = [["url", "HTTPS://a.b/c"]]
    html = render_brief(data, index)
    assert "hxxp://evil[.]example[.]com/x[.]php" in html
    assert "bad[.]example[.]org" in html and "203[.]0[.]113[.]7" in html
    assert "hxxpS://a[.]b/c" in html
    assert "evil.example.com" not in html and "203.0.113.7" not in html
    assert not re.search(r'href="[^"]*(evil|bad\.example|203\.0)', html)


def test_defang_matches_web_app():
    assert defang("http://a.b") == "hxxp://a[.]b"
    assert defang("HTTPs://x.y/z") == "hxxps://x[.]y/z"
    assert defang("xhttp.a") == "xhttp[.]a"
    assert defang("1.2.3.4") == "1[.]2[.]3[.]4"


def test_only_http_source_urls_are_links():
    assert safe_url("https://example.org/a") == "https://example.org/a"
    assert safe_url("javascript:alert(1)") is None
    assert safe_url("//evil") is None
    assert safe_url("") is None


@pytest.mark.skipif(not DASHBOARD.is_file(), reason="apps/web/dashboard.html missing")
def test_design_tokens_match_dashboard():
    """The :root token blocks are copied verbatim; flag drift from the web app."""
    dash = DASHBOARD.read_text(encoding="utf-8")
    css = (TEMPLATES / "brief.css").read_text(encoding="utf-8")
    pat = re.compile(
        r"^(:root \{.*?^\}"
        r"|@media \(prefers-color-scheme: light\) \{.*?^\} \}"
        r"|:root\[data-theme=\"light\"\] \{.*?^\})",
        re.S | re.M,
    )
    dash_blocks = pat.findall(dash)
    assert len(dash_blocks) == 3, "token blocks not found in dashboard.html"
    assert pat.findall(css) == dash_blocks
