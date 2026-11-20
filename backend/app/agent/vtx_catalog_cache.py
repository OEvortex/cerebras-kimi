"""Cheap caching for vtx's model metadata lookups.

Three separate hot spots in vtx's model discovery made the **first** turn of
every conversation wait ~6s before the model was even called (profiled with
cProfile: 11s of `ConversationRuntime.initialize()`, 10s of it in
`get_model`/`find_model`):

1. ``ContextLengthManager.get_limits`` resolves a model's limits by scanning the
   whole models.dev table, copying it into a list and normalising every key on
   every call (``model_id.lower().replace("-", "")``). ids from a provider's own
   cached list never match exactly, so they always take that path: ~1.4k scans of
   ~1.5k entries per init.
2. ``model_fetcher.get_fetched_models`` calls it once per cached model, then
   repeats an inline ``any(...)`` scan over the same table for ``is_matched``.
3. ``find_model`` rebuilds every provider's model list from its cache file on
   each call, and ``initialize()`` resolves several models.

`models.dev` limits are read-only after load (the background refresh only adds
keys), so all three are cacheable. Nothing here changes what a lookup returns —
the fast path applies the same predicate, in the same order, to the same table.
"""

from __future__ import annotations

import threading
from typing import Any

_installed = False


def install_context_limit_cache() -> None:
    """Memoise + de-quadratic ``context_length_manager.get_limits`` (idempotent)."""
    global _installed
    if _installed:
        return
    _installed = True

    try:
        from vtx.ai.context_length import TokenLimits, context_length_manager
    except Exception:  # noqa: BLE001 - vtx missing only breaks that path
        return

    manager = context_length_manager
    lock = threading.Lock()
    # (len of the limits table) -> (ids in insertion order, normalised ids)
    index: dict[int, tuple[list[str], list[str]]] = {}
    memo: dict[tuple[str, int, bool], Any] = {}

    def get_limits(model: str) -> Any:
        manager.ensure_loaded()
        limits = manager._limits
        size = len(limits)
        key = (model, size, manager._loaded)
        cached = memo.get(key)
        if cached is not None:
            return cached

        if model in limits:
            value = limits[model]
        else:
            with lock:
                snapshot = index.get(size)
                if snapshot is None:
                    ids = list(limits.keys())
                    snapshot = (ids, [i.lower().replace("-", "") for i in ids])
                    index.clear()
                    index[size] = snapshot
            ids, normalised = snapshot
            target = model.lower().replace("-", "")
            value = TokenLimits(context=0, output=0)
            for model_id, mid in zip(ids, normalised):
                if target in mid or mid in target:
                    value = limits.get(model_id, value)
                    break

        if len(memo) > 20_000:
            # A long-lived server with many model ids; start over rather than
            # growing without bound. Either way the work stays bounded.
            memo.clear()
        memo[key] = value
        return value

    manager.get_limits = get_limits  # type: ignore[method-assign]


def install_model_fetch_cache() -> None:
    """Memoise ``vtx.ai.model_fetcher.get_fetched_models`` per provider.

    ``find_model`` walks the providers and rebuilds each one's list from its
    cache file; ``initialize()`` resolves several models, so the same lists were
    rebuilt ~25 times per session. The rebuild is a pure function of the cache
    file, so cache it against the file's ``(mtime, size)``.
    """
    try:
        from vtx.ai import model_fetcher
        from vtx.ai.models import Model
    except Exception:  # noqa: BLE001
        return

    original = model_fetcher.get_fetched_models
    cache: dict[tuple[str, int, int], list[Model]] = {}

    def get_fetched_models(provider) -> list[Model]:
        slug = str(getattr(provider, "slug", "") or "")
        try:
            stat = model_fetcher._cache_path(slug).stat()
        except OSError:
            # No cache file: nothing to cache, and the caller gets the empty
            # list it always got.
            return original(provider)
        signature = (slug, stat.st_mtime_ns, stat.st_size)
        cached = cache.get(signature)
        if cached is None:
            cached = original(provider) or []
            if len(cache) > 64:
                cache.clear()
            cache[signature] = cached
        # Callers may sort or filter the result; never hand out the cache itself.
        return list(cached)

    # The vtx function's `provider` parameter is unannotated, so ty infers a
    # distinct structural type for each definition and rejects the direct
    # assignment even though the signatures are identical. Route the patch
    # through `Any` to express the deliberate monkeypatch.
    fetcher: Any = model_fetcher
    fetcher.get_fetched_models = get_fetched_models
