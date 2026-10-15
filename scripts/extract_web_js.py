#!/usr/bin/env python3
"""Extract the inline scripts from apps/web/dashboard.html for `node --check`.

    python3 scripts/extract_web_js.py OUT_DIR [HTML]

Writes one file per inline <script> that holds JavaScript (no src, and a
type that is empty, text/javascript or module): main.js for the largest
one, inline-N.js for the rest (.mjs for modules). Prints the paths written.
Exits 1 when no inline script is found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)
TYPE_RE = re.compile(r"""\btype\s*=\s*["']?([^"'\s>]+)""", re.IGNORECASE)
JS_TYPES = {"", "text/javascript", "application/javascript", "module"}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    out = Path(sys.argv[1])
    html_path = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "apps" / "web" / "dashboard.html"
    html = html_path.read_text(encoding="utf-8")

    found: list[tuple[str, str]] = []
    for attrs, body in SCRIPT_RE.findall(html):
        if re.search(r"\bsrc\s*=", attrs, re.IGNORECASE):
            continue
        m = TYPE_RE.search(attrs)
        typ = (m.group(1) if m else "").lower()
        if typ not in JS_TYPES or not body.strip():
            continue
        found.append((".mjs" if typ == "module" else ".js", body))

    if not found:
        print(f"extract_web_js: no inline JavaScript in {html_path}", file=sys.stderr)
        return 1

    out.mkdir(parents=True, exist_ok=True)
    largest = max(range(len(found)), key=lambda i: len(found[i][1]))
    for i, (ext, body) in enumerate(found):
        name = ("main" if i == largest else f"inline-{i}") + ext
        p = out / name
        p.write_text(body, encoding="utf-8")
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
