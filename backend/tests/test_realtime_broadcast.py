"""The realtime hub can push a frame to every connected client."""

from __future__ import annotations

import asyncio

from app.api.realtime import RealtimeHub


def test_broadcast_reaches_every_client():
    hub = RealtimeHub(store=object(), runtime=object())
    first = asyncio.run(hub.get("client-a"))
    second = asyncio.run(hub.get("client-b"))

    asyncio.run(hub.broadcast({"type": "turn_event", "seq": 7}))

    assert first.queue.get_nowait()["seq"] == 7
    assert second.queue.get_nowait()["seq"] == 7
