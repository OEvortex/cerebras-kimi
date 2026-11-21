"""Compatibility shim for vtx's tool-schema slimming.

``vtx.agent.tools._slim_schema`` strips every dict key named ``"title"``
wherever it appears — meant to remove pydantic's ``"title": "<Label>"``
annotations, but it also deletes a *parameter* literally named ``title``
from ``properties``, so the model never sees that argument and every call
fails validation (``notes``/``video``/``note_create`` were all affected).

This replaces the function with one that keeps property names intact and
only slims each property's schema. Imported for its side effect; safe to
import more than once.
"""

from __future__ import annotations

from typing import Any

import vtx.agent.tools as _vtx_tools

_SCHEMA_DROP_KEYS = _vtx_tools._SCHEMA_DROP_KEYS


def _slim_schema(node: Any) -> Any:
    if isinstance(node, dict):
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            non_null = [s for s in any_of if s.get("type") != "null"]
            if len(non_null) == 1:
                merged = {k: v for k, v in node.items() if k != "anyOf"}
                merged.update(non_null[0])
                node = merged
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key in _SCHEMA_DROP_KEYS:
                continue
            if key == "properties" and isinstance(value, dict):
                # Keys here are argument names the model must see verbatim —
                # slim each property's schema, never the name itself.
                out[key] = {name: _slim_schema(sub) for name, sub in value.items()}
            else:
                out[key] = _slim_schema(value)
        return out
    if isinstance(node, list):
        return [_slim_schema(item) for item in node]
    return node


_vtx_tools._slim_schema = _slim_schema
