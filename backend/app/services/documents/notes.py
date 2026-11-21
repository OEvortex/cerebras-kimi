"""One-time import of legacy markdown notes into the Co-Writer notebook.

Older versions wrote standalone markdown files under ``data/notes``; the import
runs once at startup so those notes remain visible as notebook pages. The
``notes/index`` key records which files were already imported.
"""

from __future__ import annotations

import re

from ...config import get_settings
from ...store import database
from .storage import get_co_writer_storage

_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)
_INDEX_KEY = "notes/index"


def _legacy_dir():
    return get_settings().data_dir / "notes"


def _load_index() -> dict[str, str]:
    data = database.get_state(get_settings(), _INDEX_KEY, {})
    return data if isinstance(data, dict) else {}


def _save_index(index: dict[str, str]) -> None:
    database.put_state(get_settings(), _INDEX_KEY, index)


def _parse_markdown(text: str, fallback_title: str) -> tuple[str, list[str], str]:
    """Return (title, tags, body) from a note's YAML-ish frontmatter."""
    title, tags, body = fallback_title, [], text
    match = _FRONTMATTER.match(text)
    if match:
        for line in match.group(1).splitlines():
            key, _, value = line.partition(":")
            key, value = key.strip().lower(), value.strip()
            if key == "title" and value:
                title = value
            elif key == "tags" and value:
                tags = [t.strip() for t in value.split(",") if t.strip()]
        body = text[match.end() :].lstrip("\n")
    return title, tags, body


def sync_legacy_notes() -> None:
    """Import notes written by older versions into Co-Writer, once each."""
    root = _legacy_dir()
    storage = get_co_writer_storage()
    index = _load_index()
    changed = False
    for path in sorted(root.glob("*.md")):
        doc_id = index.get(path.name)
        if doc_id and storage.doc_exists(doc_id):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        title, tags, body = _parse_markdown(text, path.stem)
        doc = storage.create_document(title=title, content=body, tags=tags)
        index[path.name] = doc.id
        changed = True
    if changed:
        _save_index(index)
