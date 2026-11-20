"""Static file serving for agent outputs and attachments (``GET /files/<path>``)."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

router = APIRouter(tags=["files"])

# Generated video lessons are pages of model-written script. Serve them in an
# opaque origin (even when opened directly) with no access to the API's cookies
# or same-origin data. The in-chat player applies the same sandbox to its iframe.
_SANDBOXED_PAGE_CSP = "sandbox allow-scripts allow-popups"

_MIME: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".zip": "application/zip",
}


def _files_root(request: Request) -> Path:
    override = os.environ.get("DEEPTUTOR_FILES_DIR", "").strip()
    if override:
        return Path(override).resolve()
    return request.app.state.settings.files_dir.resolve()


@router.get("/files/{file_path:path}")
async def serve_file(file_path: str, request: Request) -> FileResponse:
    """Serve an agent output or attachment from the backend files directory."""
    root = _files_root(request)
    resolved = (root / file_path).resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=403, detail="Forbidden")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Not Found")
    media_type = _MIME.get(resolved.suffix.lower(), "application/octet-stream")
    headers = {"Cache-Control": "private, max-age=60"}
    if media_type.startswith("text/html") and "videos" in resolved.parts:
        headers["Content-Security-Policy"] = _SANDBOXED_PAGE_CSP
    return FileResponse(resolved, media_type=media_type, headers=headers)
