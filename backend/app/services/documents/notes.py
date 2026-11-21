"""Bridge the agent's ``notes`` tool to the Co-Writer notebook.

Notes live in Co-Writer pages inside the shared SQLite database. The
``notes/index`` key records which legacy markdown files were already imported;
the import runs once, so notes saved by older versions remain visible.
"""

from __future__ import annotations

import difflib
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


def write_note(title: str, content: str, tags: str = "") -> str:
    """Save a note as a Co-Writer notebook page.

    Returns the new page id, which the agent can use to refer to the note.
    """
    doc = get_co_writer_storage().create_document(
        title=title.strip(),
        content=content,
        tags=[t.strip() for t in tags.split(",") if t.strip()],
    )
    return doc.id


def list_notes() -> str:
    """List notebook pages as ``id | title | tags: ...`` lines."""
    sync_legacy_notes()
    lines = []
    for doc in get_co_writer_storage().list_documents():
        full = get_co_writer_storage().load_document(doc.id)
        lines.append(f"{doc.id} | {doc.title} | tags: {', '.join(full.tags if full else [])}")
    return "\n".join(lines) if lines else "No notes saved yet."


def update_note(note_id: str, old_string: str, new_string: str,
                replace_all: bool = False) -> str:
    """Patch a notebook page's Markdown body in place.

    ``old_string`` must match the stored content exactly (whitespace
    included) — the same contract as vtx's ``edit`` tool. Without
    ``replace_all`` the match must be unique so a short string cannot
    silently rewrite the wrong spot; ``replace_all`` rewrites every
    occurrence. Returns a one-line summary with the diff size.
    """
    note_id = (note_id or "").strip()
    if not note_id:
        return "notes update needs a note_id (from list/search/write)."
    if not old_string:
        return "notes update needs old_string."
    if old_string == new_string:
        return "notes update needs new_string to differ from old_string."

    storage = get_co_writer_storage()
    doc = storage.load_document(note_id)
    if doc is None:
        return f"Note not found: {note_id}"

    content = doc.content or ""
    count = content.count(old_string)
    if count == 0:
        return (f"old_string not found in note '{doc.title}' ({note_id}). "
                "Copy the exact text — whitespace included — from search/list.")
    if count > 1 and not replace_all:
        return (f"old_string matches {count} places in note '{doc.title}'. "
                "Pass a longer, unique snippet or set replace_all=true.")

    new_content = (content.replace(old_string, new_string) if replace_all
                   else content.replace(old_string, new_string, 1))
    try:
        updated = storage.update_document(note_id, content=new_content)
    except Exception as exc:  # noqa: BLE001 — RevisionConflict etc.
        return f"Could not update note '{doc.title}': {exc}"
    if updated is None:
        return f"Note not found: {note_id}"

    matcher = difflib.SequenceMatcher(
        None, content.splitlines(), new_content.splitlines())
    added = removed = 0
    for tag, _i1, _i2, _j1, _j2 in matcher.get_opcodes():
        if tag in ("replace", "insert"):
            added += _j2 - _j1
        if tag in ("replace", "delete"):
            removed += _i2 - _i1
    return (f"Updated note '{updated.title}' ({note_id}) — "
            f"replaced {count if replace_all else 1} occurrence(s), "
            f"+{added} -{removed} lines.")


def search_notes(query: str) -> str:
    """Full-text search over notebook pages, including their tags."""
    q = query.strip().lower()
    if not q:
        return "notes search needs a query."
    sync_legacy_notes()
    storage = get_co_writer_storage()
    hits: list[str] = []
    for doc in storage.list_documents():
        full = storage.load_document(doc.id)
        if full is None:
            continue
        haystack = f"{full.title}\n{' '.join(full.tags)}\n{full.content}".lower()
        if q not in haystack:
            continue
        idx = full.content.lower().find(q)
        if idx >= 0:
            snippet = full.content[max(0, idx - 80) : idx + 200].replace("\n", " ")
        else:
            snippet = f"{full.title} | tags: {', '.join(full.tags)}"
        hits.append(f"[{full.id}] …{snippet}…")
    return "\n\n".join(hits[:10]) if hits else "No matching notes."
