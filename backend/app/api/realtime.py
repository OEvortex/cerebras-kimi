"""REST + SSE transport for turns and legacy feature channels.

There is no ACP / JSON-RPC layer: command bodies are the frontend's native
protocol objects, and outbound frames are the raw event objects the frontend's
`parseTurnEvent` expects. The two endpoints are:

* ``POST /api/realtime/commands`` — one turn command, or a legacy channel
  message when ``?channel=<name>`` is present.
* ``GET /api/realtime/events?client_id=<id>`` — ``text/event-stream`` carrying
  the client's outbound frames as named SSE events.

Each client gets its own controller and event queue, so events are scoped to
the client that issued the command.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/realtime")

HEARTBEAT_SECONDS = 15
# How long a pump keeps forwarding after ``done`` while the runtime finishes
# post-turn work (the generated chat title). The browser client holds its socket
# for 15s after done for exactly this reason, so stay just inside it.
POST_DONE_GRACE_SECONDS = 12.0
CLIENT_IDLE_SECONDS = 15 * 60
SWEEP_SECONDS = 60
MAX_QUEUE = 2000


# -- outbound protocol helpers ---------------------------------------------


def _command_ack(command: dict[str, Any], turn_id: str, accepted: bool,
                 error_code: str | None = None, message: str | None = None) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "command_ack",
        "protocol_version": "2.0",
        "command_id": str(command.get("command_id") or ""),
        "command_type": str(command.get("type") or ""),
        "accepted": accepted,
        "turn_id": turn_id,
    }
    if error_code:
        event["error_code"] = error_code
    if message:
        event["message"] = message
    return event


def _event_to_update(event: dict[str, Any]) -> dict[str, Any] | None:
    """Turn event -> the `session_update` mirror frame used by the UI."""
    etype = event.get("type")
    if etype == "content":
        return {
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": str(event.get("content") or "")},
        }
    if etype == "thinking":
        return {
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": str(event.get("content") or "")},
        }
    if etype == "tool_call":
        meta = event.get("metadata") or {}
        return {
            "sessionUpdate": "tool_call",
            "toolCallId": str(meta.get("tool_call_id") or event.get("turn_id") or ""),
            "title": str(meta.get("tool_name") or "tool"),
            "kind": "other",
            "status": "pending",
            "rawInput": meta.get("arguments"),
        }
    if etype == "tool_result":
        meta = event.get("metadata") or {}
        return {
            "sessionUpdate": "tool_call_update",
            "toolCallId": str(meta.get("tool_call_id") or ""),
            "status": "failed" if meta.get("is_error") else "completed",
            "rawOutput": {"output": str(event.get("content") or "")[:4000]},
        }
    if etype == "result":
        meta = event.get("metadata") or {}
        usage = meta.get("usage") or {}
        if usage:
            budget = (meta.get("metadata") or {}).get("context_budget") or {}
            return {
                "sessionUpdate": "usage_update",
                "used": usage.get("total_tokens") or usage.get("input_tokens"),
                "size": budget.get("window") or usage.get("context_window"),
            }
    return None


def _to_sse(frame: dict[str, Any]) -> str:
    """One outbound protocol frame -> one SSE frame."""
    payload = frame
    event = "turn_event"
    event_id = None
    if frame.get("type") == "session_update":
        event = "session_update"
    elif frame.get("type") == "legacy_event":
        event = "legacy_event"
    else:
        seq = frame.get("seq")
        if isinstance(seq, int):
            event_id = f"{frame.get('turn_id', '')}:{seq}"

    lines = [f"event: {event}"]
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append("data: " + json.dumps(payload, separators=(",", ":")))
    return "\n".join(lines) + "\n\n"


def _frame(event: str, payload: dict[str, Any]) -> str:
    return (
        f"event: {event}\n"
        f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
    )


# -- per-client controller ---------------------------------------------------


class _ClientSession:
    """One browser client: command dispatcher plus its outbound event queue."""

    def __init__(self, hub: "RealtimeHub", client_id: str) -> None:
        self.id = client_id
        self.hub = hub
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_QUEUE)
        self.last_seen = time.monotonic()
        self._tasks: set[asyncio.Task] = set()
        # Turns this client already has a live pump for. Every subscribe used
        # to stack another follower queue, so a reconnecting/resuming client
        # multiplied its own event copies until the SSE queue overflowed and
        # the client saw permanent seq gaps — which triggered more resumes.
        self._following: set[str] = set()

    async def emit(self, frame: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            # Never wedge a turn on a slow/stale SSE reader: drop the oldest
            # frame. The client's seq-based replay closes any resulting gap.
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(frame)
            except asyncio.QueueFull:
                pass

    async def ack(self, command: dict[str, Any], turn_id: str, accepted: bool,
                  error_code: str | None = None, message: str | None = None) -> None:
        await self.emit(_command_ack(command, turn_id, accepted, error_code, message))

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _follow_once(self, handle: Any, pump) -> None:
        """Start ``pump`` for ``handle`` unless this client already follows it."""
        if handle.turn_id in self._following:
            return
        self._following.add(handle.turn_id)
        self._spawn(pump(handle))

    # -- command dispatch ----------------------------------------------------

    async def handle(self, command: dict[str, Any], channel: str = "") -> dict[str, bool]:
        if channel:
            return await self._handle_channel(channel, command)

        ctype = command.get("type")
        if ctype in ("start_turn", "message"):
            await self._start_turn(command)
        elif ctype == "cancel_turn":
            await self._cancel_turn(command)
        elif ctype == "regenerate":
            await self._regenerate(command)
        elif ctype in ("subscribe_turn", "resume_from"):
            await self._subscribe_turn(command)
        elif ctype == "subscribe_session":
            await self._subscribe_session(command)
        elif ctype == "unsubscribe":
            await self.ack(command, "", True)
        elif ctype == "check_active_turn":
            await self._check_active(command)
            await self.ack(command, "", True)
        elif ctype == "ping":
            await self.emit({"type": "pong", "protocol_version": "2.0"})
        elif ctype in ("submit_user_reply", "user_input"):
            await self._submit_reply(command)
        return {"accepted": True}

    async def _start_turn(self, command: dict[str, Any]) -> None:
        handle, session_event, error = await self.hub.runtime.start_turn(command)
        if error or handle is None:
            await self.ack(command, "", False, "start_turn_rejected",
                           error or "failed to start turn")
            return
        if session_event is not None:
            await self.hub.runtime._emit(handle, session_event)
            await self.emit(session_event)
        await self.ack(command, handle.turn_id, True)
        self._follow_once(handle, self._pump_raw)

    async def _cancel_turn(self, command: dict[str, Any]) -> None:
        turn_id = str(command.get("turn_id") or "")
        handle = self.hub.runtime.get_turn(turn_id)
        accepted = handle is not None and handle.status == "running"
        if accepted:
            handle.cancel.set()
        await self.ack(command, turn_id, accepted,
                       None if accepted else "turn_not_running",
                       None if accepted else "No running turn with that id.")

    async def _regenerate(self, command: dict[str, Any]) -> None:
        session_id = str(command.get("session_id") or "")
        session = self.hub.store.get(session_id)
        if session is None:
            await self.emit({"type": "protocol_error", "protocol_version": "2.0",
                             "error_code": "session_not_found", "message": "session not found",
                             "retryable": False})
            return
        last_input = session.get("last_input")
        if not last_input:
            await self.emit({"type": "protocol_error", "protocol_version": "2.0",
                             "error_code": "nothing_to_regenerate", "message": "nothing to regenerate",
                             "retryable": False})
            return
        vtx_items = session.get("vtx_items", [])
        while vtx_items and vtx_items[-1].get("role") != "user":
            vtx_items.pop()
        if vtx_items:
            vtx_items.pop()
        self.hub.store.save(session)
        await self._start_turn({
            "type": "start_turn",
            "protocol_version": "2.0",
            "content": last_input,
            "session_id": session_id,
            "regenerate": True,
        })
        await self.ack(command, session_id, True)

    async def _subscribe_turn(self, command: dict[str, Any]) -> None:
        turn_id = str(command.get("turn_id") or "")
        # ``resume_from`` carries the cursor as ``seq``; ``subscribe_turn``
        # uses ``after_seq``. Reading only one made every resume replay the
        # whole turn history.
        after_seq = int(command.get("after_seq") or command.get("seq") or 0)
        if not turn_id:
            await self.emit({"type": "protocol_error", "protocol_version": "2.0",
                             "error_code": "invalid_params", "message": "turn_id required",
                             "retryable": False})
            return
        for event in self.hub.runtime.turn_events_after(turn_id, after_seq):
            await self.emit(event)
        handle = self.hub.runtime.get_turn(turn_id)
        if handle is not None and handle.status == "running":
            self._follow_once(handle, self._follow_turn)
        await self.ack(command, turn_id, True)

    async def _subscribe_session(self, command: dict[str, Any]) -> None:
        session_id = str(command.get("session_id") or "")
        after_seq = int(command.get("after_seq") or 0)
        if not session_id:
            await self.emit({"type": "protocol_error", "protocol_version": "2.0",
                             "error_code": "invalid_params", "message": "session_id required",
                             "retryable": False})
            return
        handle = self.hub.runtime.active_turn_for_session(session_id)
        if handle is None:
            await self.emit({"type": "active_turn_info", "protocol_version": "2.0",
                             "status": "none"})
            await self.ack(command, "", True)
            return
        for event in self.hub.runtime.turn_events_after(handle.turn_id, after_seq):
            await self.emit(event)
        if handle.status == "running":
            self._follow_once(handle, self._follow_turn)
        await self.ack(command, handle.turn_id, True)

    async def _check_active(self, command: dict[str, Any]) -> None:
        session_id = str(command.get("session_id") or "")
        handle = self.hub.runtime.active_turn_for_session(session_id)
        if handle is None:
            await self.emit({"type": "active_turn_info", "protocol_version": "2.0",
                             "status": "none"})
        else:
            await self.emit({"type": "active_turn_info", "protocol_version": "2.0",
                             "turn_id": handle.turn_id, "status": "running"})

    async def _submit_reply(self, command: dict[str, Any]) -> None:
        turn_id = str(command.get("turn_id") or "")
        answers = [a for a in (command.get("answers") or []) if isinstance(a, dict)]
        text = str(command.get("text") or "")
        accepted = await self.hub.runtime.resolve_ask_user(turn_id, text, answers)
        await self.ack(command, turn_id, accepted,
                       None if accepted else "no_pending_question",
                       None if accepted else "No question is waiting on this turn.")

    # -- event pumps ---------------------------------------------------------

    async def _forward_until_settled(self, handle: Any, queue: asyncio.Queue) -> None:
        """Keep forwarding frames the runtime settles *after* ``done``.

        The conversation title is generated in the background once the turn is
        done, so the client cannot be told about it before ``done`` without
        blocking the turn. Instead of closing the moment ``done`` is seen, wait
        on the handle's ``settled`` event — set when the title attempt finished,
        or when there was nothing to do — and forward anything that arrives
        meanwhile. Bounded, so a hung title endpoint cannot pin an event stream
        open forever.
        """
        settled = getattr(handle, "settled", None)
        if settled is None or settled.is_set():
            return
        loop = asyncio.get_running_loop()
        deadline = loop.time() + POST_DONE_GRACE_SECONDS
        while not settled.is_set():
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            getter = asyncio.ensure_future(queue.get())
            settler = asyncio.ensure_future(settled.wait())
            done, pending = await asyncio.wait(
                {getter, settler},
                timeout=remaining,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            if getter in done and not getter.cancelled():
                await self.emit(getter.result())
        # Anything already handed to the queue before the signal still goes out.
        while not queue.empty():
            await self.emit(queue.get_nowait())

    async def _pump_raw(self, handle: Any) -> None:
        """Forward a turn's events (plus session/update mirrors) until done."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        handle.subscribers.add(queue)
        try:
            # A fast (often cached) turn can emit its whole sequence before
            # this coroutine subscribes. Replay what already happened; the
            # client de-dupes by seq, so overlap with live frames is harmless.
            for event in list(handle.events):
                await self.emit(event)
            while True:
                event = await queue.get()
                await self.emit(event)
                upd = _event_to_update(event)
                if upd is not None:
                    await self.emit({
                        "type": "session_update",
                        "session_id": handle.session_id,
                        "update": upd,
                    })
                if event.get("type") == "done":
                    await self._forward_until_settled(handle, queue)
                    return
        finally:
            handle.subscribers.discard(queue)
            self._following.discard(handle.turn_id)

    async def _follow_turn(self, handle: Any) -> None:
        """Forward a running turn's raw events to a late subscriber."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        handle.subscribers.add(queue)
        try:
            while True:
                event = await queue.get()
                await self.emit(event)
                if event.get("type") == "done":
                    await self._forward_until_settled(handle, queue)
                    return
        finally:
            handle.subscribers.discard(queue)
            self._following.discard(handle.turn_id)

    # -- legacy feature channels ---------------------------------------------

    async def _handle_channel(self, channel: str, message: dict[str, Any]) -> dict[str, bool]:
        if "judge" in channel:
            await self.emit({"type": "started"})
            try:
                from ..agent.quiz import judge_answer

                text = await judge_answer(message)
                # Stream in small chunks like the old WS judge did.
                for start in range(0, len(text), 120):
                    await self.emit({"type": "text", "content": text[start : start + 120]})
                await self.emit({"type": "done"})
            except Exception as exc:  # noqa: BLE001
                await self.emit({"type": "error", "content": f"AI judge failed: {exc}"})
        elif "books" in channel:
            await self.emit({"type": "ack", "status": "ok"})
        elif "mastery" in channel or "progress" in channel:
            await self.emit({"type": "subscribed", "revision": 0})
        else:
            await self.emit({"type": "ack"})
        return {"accepted": True}

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()


class RealtimeHub:
    """Registry of live client sessions, shared by the REST routes."""

    def __init__(self, store: Any, runtime: Any) -> None:
        self.store = store
        self.runtime = runtime
        self._clients: dict[str, _ClientSession] = {}
        self._lock = asyncio.Lock()
        self._sweeper: asyncio.Task | None = None

    def start(self) -> None:
        if self._sweeper is None:
            self._sweeper = asyncio.create_task(self._sweep())

    async def stop(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            self._sweeper = None
        for client_id in list(self._clients):
            await self.release(client_id)

    async def get(self, client_id: str) -> _ClientSession:
        async with self._lock:
            client = self._clients.get(client_id)
            if client is None:
                client = _ClientSession(self, client_id)
                self._clients[client_id] = client
            client.last_seen = time.monotonic()
            return client

    async def release(self, client_id: str) -> None:
        async with self._lock:
            client = self._clients.pop(client_id, None)
        if client is not None:
            await client.close()

    async def broadcast(self, frame: dict[str, Any]) -> None:
        """Push a frame to every connected browser client.

        Used for detached work (a notebook sub-agent finishing long after its
        parent turn ended) that has no live turn pump to write into.
        """
        async with self._lock:
            clients = list(self._clients.values())
        for client in clients:
            await client.emit(frame)

    async def _sweep(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_SECONDS)
            now = time.monotonic()
            async with self._lock:
                stale = [
                    cid for cid, client in self._clients.items()
                    if now - client.last_seen > CLIENT_IDLE_SECONDS
                ]
            for client_id in stale:
                await self.release(client_id)


# -- routes -----------------------------------------------------------------


@router.post("/commands")
async def submit_command(request: Request) -> dict[str, bool]:
    """Accept one turn command or legacy channel message over HTTP."""
    client_id = request.query_params.get("client_id") or uuid.uuid4().hex
    channel = request.query_params.get("channel") or ""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Command must be a JSON object")

    client = await client_for(request).get(client_id)
    return await client.handle(body, channel)


@router.get("/events")
async def stream_events(request: Request) -> StreamingResponse:
    """Deliver the client's outbound frames as a named-event SSE stream."""
    client_id = request.query_params.get("client_id") or uuid.uuid4().hex
    client = await client_for(request).get(client_id)

    async def generate() -> AsyncIterator[str]:
        yield _frame("ready", {"client_id": client_id})
        last_beat = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(client.queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    now = time.monotonic()
                    if now - last_beat >= HEARTBEAT_SECONDS:
                        yield ": ping\n\n"
                        last_beat = now
                    continue
                client.last_seen = time.monotonic()
                yield _to_sse(frame)
        finally:
            # Keep the client registered: EventSource reconnects with the same
            # id, and an idle sweep reclaims clients that never come back.
            client.last_seen = time.monotonic()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.delete("/clients/{client_id}")
async def close_client(request: Request, client_id: str) -> dict[str, bool]:
    await client_for(request).release(client_id)
    return {"closed": True}


def client_for(request: Request) -> RealtimeHub:
    return request.app.state.realtime
