"""Authenticated account calendar and workspace-local learning overlays.

Mounted at ``/api/calendar``. The wire contract follows RFC 5545: all-day
events carry plain dates with an exclusive end, timed events carry UTC
instants. Everything lives in the shared ``data/deeptutor.sqlite3`` database.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import timedelta
import re

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import ValidationError

from ..services.calendar import models as m
from ..services.calendar.ics import ics_filename, render_calendar
from ..services.calendar.layers import read_layers
from ..services.calendar.recurrence import parse_instant, zone
from ..services.calendar.store import get_calendar_store

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

_UNSAFE = re.compile(r'[^\w.\- ]+')


@contextmanager
def errors():
    try:
        yield
    except KeyError as exc:
        raise HTTPException(404, "Calendar item not found.") from exc
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def bounds(start, end, tz):
    with errors():
        first, last = parse_instant(start), parse_instant(end)
        zone(tz)
        if not first < last or last - first > timedelta(days=400):
            raise ValueError("Choose a range between one second and 400 days.")
        return first, last


def board_workspace(request: Request) -> str:
    """The content workspace this request is scoped to; ``""`` is General."""
    params = request.query_params
    value = params.get("dt_workspace")
    if value is None:
        value = params.get("workspace")
    if value is None:
        value = request.headers.get("x-dt-workspace", "")
    return value or ""


def content_disposition(filename: str, *, disposition: str = "attachment") -> str:
    """RFC 6266 header; the plain name is a fallback for non-UTF-8 clients."""
    clean = _UNSAFE.sub("-", filename).strip(" .") or "file"
    quoted = clean.replace("\\", "\\\\").replace('"', '\\"')
    return f"{disposition}; filename=\"{quoted}\"; filename*=UTF-8''{_quote(clean)}"


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


@router.get(
    "/export.ics",
    response_class=Response,
    responses={200: {"content": {"text/calendar": {"schema": {"type": "string"}}}}},
)
def export_ics(calendar_id: str | None = Query(default=None)):
    """Download stored events as an iCalendar attachment.

    Args:
        calendar_id: Limit the file to one calendar. Omit to include every
            visible calendar. Unknown ids return 404. Workspace overlay
            layers are not included.
    """
    store = get_calendar_store()
    with errors():
        calendars, events = store.export(calendar_id)
    if calendar_id is None:
        name = "DeepTutor"
        filename = "deeptutor.ics"
    else:
        name = calendars[0].name.strip() or "calendar"
        filename = ics_filename(name)
    with errors():
        body = render_calendar(calendars, events, calendar_name=name)
    return Response(
        content=body.encode("utf-8"),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": content_disposition(filename, disposition="attachment")},
    )


@router.get("/calendars", response_model=m.CalendarList)
def calendars():
    return get_calendar_store().calendars()


@router.post("/calendars", response_model=m.CalendarResponse, status_code=201)
def create_calendar(payload: m.CreateCalendar):
    return get_calendar_store().create_calendar(payload)


@router.patch("/calendars/{id}", response_model=m.CalendarResponse)
def update_calendar(id: str, payload: m.UpdateCalendar):
    with errors():
        return get_calendar_store().update_calendar(id, payload)


@router.delete("/calendars/{id}", response_model=m.CalendarRevision)
def delete_calendar(id: str):
    with errors():
        return get_calendar_store().delete_calendar(id)


@router.get("/events", response_model=m.OccurrenceList)
def events(start: str, end: str, tz: str = "UTC"):
    first, last = bounds(start, end, tz)
    with errors():
        return get_calendar_store().occurrences(first, last, tz)


@router.post("/events", response_model=m.CalendarEventResponse, status_code=201)
def create_event(payload: m.EventInput):
    with errors():
        return get_calendar_store().create(payload)


@router.patch("/events/{id}", response_model=m.CalendarRevision)
def update_event(id: str, payload: m.EventPatchRequest):
    with errors():
        return get_calendar_store().update(id, payload)


@router.delete("/events/{id}")
def delete_event(id: str, scope: m.Scope = "all", occurrence: str | None = None):
    with errors():
        return get_calendar_store().delete(id, scope, occurrence)


@router.post("/undo/{token}", response_model=m.CalendarRevision)
def undo(token: str):
    with errors():
        return get_calendar_store().restore(token)


@router.get("/search", response_model=m.CalendarSearchResponse)
def search(
    q: str = Query(min_length=1, max_length=200), limit: int = Query(default=50, ge=1, le=100)
):
    with errors():
        return get_calendar_store().search(q, limit)


@router.get("/layers", response_model=m.CalendarLayers)
def layers(request: Request, start: str, end: str, tz: str = "UTC"):
    first, last = bounds(start, end, tz)
    return read_layers(board_workspace(request), first, last, tz)


@router.delete("/automations/{job_id}", response_model=m.CalendarOk)
def cancel_automation(job_id: str, request: Request):
    """Cancel a scheduled reminder created from this workspace's chat."""
    from ..services.calendar.layers import owner_key
    from ..services.cron import get_cron_service

    service = get_cron_service()
    job = service.get_job(job_id)
    if (
        not job
        or job.owner.key != owner_key()
        or job.owner.kind != "chat"
        or job.owner.workspace_id != board_workspace(request)
    ):
        raise HTTPException(404, "Automation not found.")
    return {"ok": service.cancel_job(job_id, owner_key=owner_key())}


@router.get("/stream")
async def stream(request: Request):
    store = await asyncio.to_thread(get_calendar_store)

    async def changes():
        revision = -1
        tick = 0
        while not await request.is_disconnected():
            current = await asyncio.to_thread(store.revision)
            if current != revision:
                revision = current
                yield f'id: {revision}\ndata: {{"revision":{revision}}}\n\n'
            elif tick % 30 == 0:
                yield ": heartbeat\n\n"
            tick += 1
            await asyncio.sleep(0.5)

    return StreamingResponse(
        changes(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Content-Encoding": "identity",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/task-blocks", response_model=dict[str, int])
def task_blocks(request: Request):
    return get_calendar_store().task_blocks(board_workspace(request))
