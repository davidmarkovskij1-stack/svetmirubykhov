#!/usr/bin/env python3
"""Sync the church YouTube channel into data/youtube.json.

Runs on GitHub Actions (cron) and can be run by hand:
    python scripts/sync_youtube.py
"""

from __future__ import annotations

import html as html_lib
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

CHANNEL_ID = "UCww4NuLLI4zRLHkPz1tX9HQ"
HANDLE = "ЦерковьСветмируБыхов"
RSS_URL = f"https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}"
LIVE_URL = "https://www.youtube.com/@" + urllib.parse.quote(HANDLE) + "/live"
OUT = Path(__file__).resolve().parent.parent / "data" / "youtube.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
NS = {
    "a": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}
MINSK = timezone(timedelta(hours=3))


def fetch(url: str, timeout: int = 30) -> tuple[str, str]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "ru,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.geturl(), response.read().decode("utf-8", "replace")


def split_title(raw: str) -> dict[str, str]:
    """Turn "Проповедь - Имя | Вечернее служение" into its three parts."""
    match = re.match(r"^(?P<title>.+?) - (?P<speaker>[^|]+?) \| (?P<kind>[^|]+)$", raw.strip())
    if match:
        return {
            "title": match.group("title").strip(),
            "speaker": match.group("speaker").strip(),
            "kind": match.group("kind").strip(),
        }
    return {"title": raw.strip(), "speaker": "", "kind": ""}


def service_date(published: str, kind: str) -> str:
    """Date of the service itself (Sunday or Wednesday), not the upload time."""
    try:
        moment = datetime.fromisoformat(published.replace("Z", "+00:00")).astimezone(MINSK)
    except ValueError:
        return published[:10]
    lowered = kind.lower()
    target = 6 if "воскрес" in lowered else 2 if "вечерн" in lowered else None
    if target is None:
        return moment.date().isoformat()
    while moment.weekday() != target:
        moment -= timedelta(days=1)
    return moment.date().isoformat()


def videos() -> list[dict[str, str]]:
    _, body = fetch(RSS_URL)
    root = ET.fromstring(body)
    result: list[dict[str, str]] = []
    for entry in root.findall("a:entry", NS):
        video_id = (entry.findtext("yt:videoId", "", NS) or "").strip()
        raw_title = (entry.findtext("a:title", "", NS) or "").strip()
        published = (entry.findtext("a:published", "", NS) or "").strip()
        if not video_id or not raw_title:
            continue
        parts = split_title(html_lib.unescape(raw_title))
        result.append({
            "id": video_id,
            **parts,
            "published": published,
            "date": service_date(published, parts["kind"]),
            "thumb": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        })
        if len(result) >= 6:
            break
    return result


def live_state() -> dict[str, object]:
    final_url, page = fetch(LIVE_URL)
    match = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", final_url)
    is_live = bool(match) and ("\"isLive\":true" in page or "hlsManifestUrl" in page)
    title = ""
    if is_live:
        found = re.search(r'<meta name="title" content="([^"]+)"', page)
        if found:
            title = html_lib.unescape(found.group(1)).replace(" - YouTube", "").strip()
    return {
        "isLive": is_live,
        "videoId": match.group(1) if is_live else "",
        "title": title if is_live else "",
    }


def main() -> int:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    previous: dict = {}
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            previous = {}

    try:
        items = videos()
    except Exception as error:
        print(f"feed fetch failed: {error}", flush=True)
        items = previous.get("videos") or []

    try:
        live = live_state()
        live["checkedAt"] = now
    except Exception as error:
        print(f"live check failed: {error}", flush=True)
        live = dict(previous.get("live") or {})
        live.setdefault("checkedAt", "")

    payload = {"updatedAt": now, "live": live, "videos": items}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if OUT.exists() and OUT.read_text(encoding="utf-8") == text:
        print("no changes", flush=True)
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {len(items)} videos, live={live.get('isLive')}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
