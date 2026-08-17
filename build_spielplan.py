#!/usr/bin/env python3
"""Spielplan aus spielplan.pdf nach spielplan.json."""
from __future__ import annotations

import json
import re
from pathlib import Path

from pypdf import PdfReader

TEAM_MAP = {
    "FC Lausanne-Sport": "Lausanne-Sport",
    "Grasshopper Club Zürich": "Grasshoppers",
    "Servette FC": "Servette FC",
    "FC Basel 1893": "FC Basel",
    "FC Luzern": "FC Luzern",
    "FC Thun": "FC Thun",
    "BSC Young Boys": "BSC Young Boys",
    "FC Lugano": "FC Lugano",
    "FC Vaduz": "FC Vaduz",
    "FC St.Gallen 1879": "FC St. Gallen",
    "FC Zürich": "FC Zürich",
    "FC Sion": "FC Sion",
}

DAY = r"(?:Sat|Sun|Mon|Tue|Wed|Thu|Fri|Sat/Sun)"
# DD.MM.YY, DD./DD.MM.YY oder DD.MM.YY / DD.MM.YY
DATE = r"(\d{2}(?:\./\d{2})?\.\d{2}\.\d{2}(?:\*)?(?:\s*/\s*\d{2}\.\d{2}\.\d{2})?)"
DASH = r"[–-]"


def map_team(name: str) -> str | None:
    return TEAM_MAP.get(re.sub(r"\s+", " ", name.strip()))


def parse_date(date_str: str) -> str | None:
    date_str = date_str.replace("*", "").strip()
    m = re.match(r"(\d{2})\./\d{2}\.(\d{2})\.(\d{2})", date_str)
    if m:
        d, mo, y = m.groups()
        return f"20{y}-{mo}-{d}"
    m = re.match(r"(\d{2})\.(\d{2})\.(\d{2})", date_str)
    if m:
        d, mo, y = m.groups()
        return f"20{y}-{mo}-{d}"
    return None


def calc_search_start(date: str, time: str) -> str:
    if not time or time == "00:00":
        return ""
    h, m = map(int, time.split(":"))
    total = h * 60 + m + 110
    return f"{date}T{total // 60:02d}:{total % 60:02d}:00"


def parse_match_line(line: str, cur_date: str | None, cur_time: str | None):
    line = line.strip()

    m = re.match(
        rf"{DATE}\s+{DAY}\s+(\d{{2}}:\d{{2}})\s+(.+?)\s+{DASH}\s+(.+?)(?:\s+SRG)?$",
        line,
    )
    if m:
        return parse_date(m.group(1)), m.group(2), map_team(m.group(3)), map_team(m.group(4))

    m = re.match(
        rf"{DATE}\s+/?\s*{DAY}\s+(.+?)\s+{DASH}\s+(.+?)(?:\s+SRG)?$",
        line,
    )
    if m:
        return parse_date(m.group(1)), "00:00", map_team(m.group(2)), map_team(m.group(3))

    m = re.match(
        rf"(\d{{2}}\.\d{{2}}\.\d{{2}})\s+(.+?)\s+{DASH}\s+(.+?)(?:\s+SRG)?$",
        line,
    )
    if m:
        return parse_date(m.group(1)), "00:00", map_team(m.group(2)), map_team(m.group(3))

    m = re.match(rf"(.+?)\s+{DASH}\s+(.+?)(?:\s+SRG)?$", line)
    if m and cur_date:
        return cur_date, cur_time or "00:00", map_team(m.group(1)), map_team(m.group(2))

    return None


def extract_matches(pdf_path: Path) -> list[dict]:
    full = "\n".join(p.extract_text() or "" for p in PdfReader(pdf_path).pages)
    all_matches: list[dict] = []
    cur_date: str | None = None
    cur_time: str | None = None

    for raw_line in full.split("\n"):
        line = raw_line.strip()
        line = re.sub(r"^Round\s+\d+\s+", "", line)
        if (
            not line
            or "Alle 228" in line
            or "SPIELPLAN" in line
            or line.startswith("Date ")
            or line.startswith("*Spielverschiebung")
            or re.match(r"Runden / Tours", line)
            or re.match(r"^Round\s+\d+$", line)
        ):
            continue

        parsed = parse_match_line(line, cur_date, cur_time)
        if not parsed:
            continue

        cur_date, cur_time, home, away = parsed
        if home and away:
            all_matches.append(
                {"date": cur_date, "time": cur_time, "home": home, "away": away}
            )

    return all_matches


def build_spielplan(pdf_path: Path) -> dict:
    matches = extract_matches(pdf_path)
    if len(matches) % 6 != 0:
        raise SystemExit(f"Unerwartete Spielanzahl: {len(matches)} (kein Vielfaches von 6)")

    matchdays = []
    for i in range(0, len(matches), 6):
        chunk = matches[i : i + 6]
        matchdays.append(
            {
                "matchday": len(matchdays) + 1,
                "matches": [
                    {
                        "date": m["date"],
                        "time": m["time"],
                        "home": m["home"],
                        "away": m["away"],
                        "searchStart": calc_search_start(m["date"], m["time"]),
                    }
                    for m in chunk
                ],
            }
        )

    return {
        "competition": "Swiss Super League",
        "season": "2026/27",
        "matchdays": matchdays,
    }


if __name__ == "__main__":
    root = Path(__file__).parent
    spielplan = build_spielplan(root / "spielplan.pdf")
    out = root / "spielplan.json"
    out.write_text(json.dumps(spielplan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(spielplan['matchdays'])} Spieltage, {sum(len(m['matches']) for m in spielplan['matchdays'])} Spiele -> {out}")
