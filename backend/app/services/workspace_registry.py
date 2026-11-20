"""Content workspace registry for the settings UI.

The frontend treats ``/api/settings/workspace/registrations`` as a catalog:
``{root, workspaces: [...]}``. Each row describes one workspace folder, its
kind (``system``/``general``/``workspace``), assigned resources and
instructions. This module owns that catalog and the filesystem operations the
settings page exposes (create, rename, archive, migrate, browse).
"""

from __future__ import annotations

import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import Settings


MAX_WORKSPACE_INSTRUCTIONS_CHARS = 10_000
SYSTEM_WORKSPACE_ID = "ws_system"
GENERAL_WORKSPACE_ID = "ws_general"
RESOURCE_KINDS = ("skills", "mcp", "knowledge_bases")


class WorkspaceError(ValueError):
    """A workspace path, registration, or operation is not allowed."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_resources() -> dict[str, list[str] | None]:
    return {kind: None for kind in RESOURCE_KINDS}


def _normalize_resources(value: Any) -> dict[str, list[str] | None]:
    if value is None:
        return _empty_resources()
    if not isinstance(value, dict):
        raise WorkspaceError("Workspace resources must be an object.")
    normalized: dict[str, list[str] | None] = {}
    for kind in RESOURCE_KINDS:
        items = value.get(kind)
        if items is None:
            normalized[kind] = None
            continue
        if not isinstance(items, list) or len(items) > 1000:
            raise WorkspaceError(f"Workspace resources for {kind} must be a list.")
        ids: list[str] = []
        for item in items:
            text = str(item).strip()
            if text and text not in ids:
                ids.append(text)
        normalized[kind] = ids
    return normalized


def _validate_instructions(value: Any) -> str:
    if not isinstance(value, str) or len(value) > MAX_WORKSPACE_INSTRUCTIONS_CHARS:
        raise WorkspaceError(
            "Workspace instructions must be text of at most "
            f"{MAX_WORKSPACE_INSTRUCTIONS_CHARS} characters."
        )
    return value.strip()


def _validate_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name or len(name) > 100:
        raise WorkspaceError("A workspace name must contain 1 to 100 characters.")
    return name


class WorkspaceRegistry:
    """Workspace catalog stored in the shared database."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = threading.RLock()

    # -- persistence ------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        from ..store import database

        raw = database.get_state(self._settings, "workspaces", {})
        if not isinstance(raw, dict):
            raw = {}
        root = str(raw.get("root") or "").strip()
        data = {
            "version": 1,
            "root": root or str(self._settings.workspace_dir),
            "workspaces": raw.get("workspaces") if isinstance(raw.get("workspaces"), list) else [],
            "migration": raw.get("migration") if isinstance(raw.get("migration"), dict) else None,
        }
        self._ensure_builtins(data)
        return data

    def _save(self, data: dict[str, Any]) -> None:
        from ..store import database

        database.put_state(self._settings, "workspaces", data)

    @property
    def root(self) -> Path:
        return Path(self._load()["root"]).expanduser().resolve()

    def _ensure_builtins(self, data: dict[str, Any]) -> None:
        root = Path(data["root"]).expanduser().resolve()
        rows: list[dict[str, Any]] = [
            row for row in data["workspaces"] if isinstance(row, dict) and row.get("workspace_id")
        ]
        known = {str(row["workspace_id"]) for row in rows}
        changed = False
        for kind, workspace_id, name in (
            ("system", SYSTEM_WORKSPACE_ID, "System workspace"),
            ("general", GENERAL_WORKSPACE_ID, "General workspace"),
        ):
            if workspace_id in known:
                continue
            path = root / kind
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError:
                pass
            rows.append(
                {
                    "workspace_id": workspace_id,
                    "display_name": name,
                    "path": str(path),
                    "kind": kind,
                    "follows_root": True,
                    "archived": False,
                    "created_at": _now(),
                    "instructions": "",
                    "resources": _empty_resources(),
                }
            )
            known.add(workspace_id)
            changed = True
        data["workspaces"] = rows
        if changed:
            self._save(data)

    # -- rows -------------------------------------------------------------

    @staticmethod
    def _status(path: Path) -> tuple[str, str]:
        try:
            if not path.is_dir():
                return "invalid", "The workspace folder does not exist."
            if not os.access(path, os.R_OK | os.W_OK | os.X_OK):
                return "invalid", "The workspace folder is not accessible."
        except OSError as exc:
            return "invalid", str(exc)
        return "ready", ""

    def _row(self, row: dict[str, Any]) -> dict[str, Any]:
        path = Path(str(row.get("path") or "")).expanduser()
        status, error = self._status(path)
        return {
            "workspace_id": str(row.get("workspace_id") or ""),
            "display_name": str(row.get("display_name") or row.get("workspace_id") or ""),
            "path": str(path),
            "kind": str(row.get("kind") or "workspace"),
            "follows_root": bool(row.get("follows_root", False)),
            "archived": bool(row.get("archived")),
            "created_at": str(row.get("created_at") or ""),
            "status": status,
            "error": str(row.get("error") or error),
            "instructions": str(row.get("instructions") or ""),
            "resources": _normalize_resources(row.get("resources")),
        }

    def _find(self, data: dict[str, Any], workspace_id: str) -> dict[str, Any]:
        row = next(
            (item for item in data["workspaces"] if item.get("workspace_id") == workspace_id),
            None,
        )
        if row is None:
            raise WorkspaceError("Workspace not found.")
        return row

    def describe(self) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            rows = [self._row(row) for row in data["workspaces"]]
            rows.sort(
                key=lambda row: (
                    {"system": 0, "general": 1}.get(row["kind"], 2),
                    row["display_name"].casefold(),
                )
            )
            return {"root": data["root"], "workspaces": rows, "migration": data.get("migration")}

    def workspace(self, workspace_id: str) -> dict[str, Any]:
        with self._lock:
            return self._row(self._find(self._load(), workspace_id))

    # -- filesystem helpers ----------------------------------------------

    @staticmethod
    def _resolve_path(value: Any, *, must_exist: bool) -> Path:
        text = str(value or "").strip()
        if not text:
            raise WorkspaceError("A workspace folder path is required.")
        try:
            path = Path(text).expanduser().resolve()
        except (OSError, RuntimeError, ValueError) as exc:
            raise WorkspaceError("The workspace folder path is invalid.") from exc
        if path.exists() and not path.is_dir():
            raise WorkspaceError("The workspace path must be a folder.")
        if must_exist and not path.is_dir():
            raise WorkspaceError("The selected workspace folder does not exist.")
        return path

    @staticmethod
    def _copy_workspace(source: Path, destination: Path) -> None:
        if destination.exists():
            raise WorkspaceError("The destination folder already exists.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            if source.is_dir():
                shutil.copytree(source, destination, symlinks=True)
            else:
                destination.mkdir(parents=True)
        except OSError as exc:
            if destination.exists():
                shutil.rmtree(destination, ignore_errors=True)
            raise WorkspaceError(f"Could not copy the workspace folder: {exc}") from exc

    # -- mutations --------------------------------------------------------

    def create(
        self,
        name: Any,
        path: Any = None,
        *,
        resources: Any = None,
        instructions: Any = None,
    ) -> dict[str, Any]:
        with self._lock:
            display_name = _validate_name(name)
            data = self._load()
            root = Path(data["root"]).expanduser().resolve()
            normalized_resources = _normalize_resources(resources)
            normalized_instructions = "" if instructions is None else _validate_instructions(instructions)
            workspace_id = f"ws_{uuid.uuid4().hex}"
            if path:
                target = self._resolve_path(path, must_exist=True)
            else:
                target = (root / workspace_id).resolve()
                try:
                    target.mkdir(parents=True, exist_ok=False)
                except OSError as exc:
                    raise WorkspaceError(f"Could not create the workspace folder: {exc}") from exc
            for row in data["workspaces"]:
                try:
                    same = Path(str(row.get("path") or "")).expanduser().resolve() == target
                except (OSError, RuntimeError, ValueError):
                    continue
                if same:
                    return self._update_locked(
                        data,
                        str(row["workspace_id"]),
                        name=display_name,
                        archived=False,
                        resources=normalized_resources,
                        instructions=normalized_instructions,
                    )
            row = {
                "workspace_id": workspace_id,
                "display_name": display_name,
                "path": str(target),
                "kind": "workspace",
                "follows_root": not bool(path),
                "archived": False,
                "created_at": _now(),
                "instructions": normalized_instructions,
                "resources": normalized_resources,
            }
            data["workspaces"].append(row)
            self._save(data)
            return self._row(row)

    def update(self, workspace_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            return self._update_locked(self._load(), workspace_id, **changes)

    def _update_locked(self, data: dict[str, Any], workspace_id: str, **changes: Any) -> dict[str, Any]:
        row = self._find(data, workspace_id)
        kind = str(row.get("kind") or "workspace")
        if kind == "system":
            raise WorkspaceError("The system workspace cannot be changed.")
        if "name" in changes and changes["name"] is not None:
            if kind == "general":
                raise WorkspaceError("The default workspace cannot be renamed.")
            row["display_name"] = _validate_name(changes["name"])
        if "archived" in changes and changes["archived"] is not None:
            if kind == "general":
                raise WorkspaceError("The default workspace cannot be archived.")
            row["archived"] = bool(changes["archived"])
        if "instructions" in changes and changes["instructions"] is not None:
            row["instructions"] = _validate_instructions(changes["instructions"])
        if "resources" in changes and changes["resources"] is not None:
            row["resources"] = _normalize_resources(changes["resources"])
        self._save(data)
        return self._row(row)

    def migrate(self, workspace_id: str, destination: Any) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            row = self._find(data, workspace_id)
            source = Path(str(row.get("path") or "")).expanduser().resolve()
            target = self._resolve_path(destination, must_exist=False)
            if target == source:
                return self.describe()
            self._copy_workspace(source, target)
            row["path"] = str(target)
            row["follows_root"] = False
            self._save(data)
            return self.describe()

    def migrate_root(self, destination: Any) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            current_root = Path(data["root"]).expanduser().resolve()
            target = self._resolve_path(destination, must_exist=False)
            if target == current_root:
                return self.describe()
            if target.is_relative_to(current_root):
                raise WorkspaceError("The new root cannot be inside the current workspace root.")
            target.mkdir(parents=True, exist_ok=True)
            movable = [
                row
                for row in data["workspaces"]
                if row.get("follows_root") and (Path(str(row.get("path") or "")).expanduser().resolve() != target)
            ]
            created: list[Path] = []
            try:
                for row in movable:
                    source = Path(str(row.get("path") or "")).expanduser().resolve()
                    destination_path = (target / str(row["workspace_id"])).resolve()
                    if destination_path == source:
                        continue
                    self._copy_workspace(source, destination_path)
                    created.append(destination_path)
                    row["path"] = str(destination_path)
            except Exception:
                for path in created:
                    shutil.rmtree(path, ignore_errors=True)
                raise
            data["root"] = str(target)
            self._save(data)
            return self.describe()

    # -- folder picker ----------------------------------------------------

    def browse(self, path: str = "") -> dict[str, Any]:
        configured = os.environ.get("DT_WORKSPACE_BROWSER_ROOTS", "").strip()
        roots: list[Path] = []
        candidates = (
            [Path(value).expanduser() for value in configured.split(os.pathsep) if value.strip()]
            if configured
            else [self._settings.workspace_dir, self._settings.data_dir.parent]
        )
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
            except (OSError, RuntimeError, ValueError):
                continue
            if resolved.is_dir() and resolved not in roots:
                roots.append(resolved)
        if not roots:
            raise WorkspaceError("No browsable workspace folders are configured.")
        try:
            if "\x00" in path:
                raise ValueError("Invalid path")
            current = Path(path).expanduser().resolve() if path else roots[0]
        except (OSError, RuntimeError, ValueError) as exc:
            raise WorkspaceError("The server folder path is invalid.") from exc
        containing = [root for root in roots if current.is_relative_to(root)]
        if not containing:
            raise WorkspaceError("This folder is outside the configured browsing roots.")
        root = max(containing, key=lambda item: len(item.parts))
        folders: list[dict[str, str]] = []
        scanned = 0
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    scanned += 1
                    if scanned > 10_000:
                        break
                    if entry.name.startswith("."):
                        continue
                    try:
                        target = Path(entry.path).resolve()
                        if (
                            entry.is_dir()
                            and target != current
                            and target.is_relative_to(root)
                            and os.access(target, os.R_OK | os.X_OK)
                        ):
                            folders.append({"name": entry.name, "path": str(target)})
                    except (OSError, RuntimeError):
                        continue
        except OSError as exc:
            raise WorkspaceError("The selected server folder cannot be opened.") from exc
        folders.sort(key=lambda entry: (entry["name"].casefold(), entry["name"]))
        return {
            "roots": [{"name": item.name or str(item), "path": str(item)} for item in roots],
            "path": str(current),
            "name": current.name or str(current),
            "parent": str(current.parent) if current != root else None,
            "folders": folders[:500],
            "truncated": len(folders) > 500 or scanned > 10_000,
        }

    # -- resources --------------------------------------------------------

    def resource_usage(self, kind: str, resource_id: str) -> list[dict[str, str]]:
        if kind not in RESOURCE_KINDS or not resource_id:
            return []
        with self._lock:
            data = self._load()
            return [
                {"workspace_id": row["workspace_id"], "display_name": row["display_name"]}
                for row in data["workspaces"]
                if resource_id in (_normalize_resources(row.get("resources")).get(kind) or [])
            ]


def workspace_snapshot(settings: Settings) -> dict[str, Any]:
    """Read-only configuration snapshot shown in the built-in system workspace."""
    from .. import provider_config

    catalog = provider_config.load_catalog(settings)
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    models: dict[str, Any] = {}
    for service in provider_config.SERVICES:
        bucket = services.get(service) if isinstance(services.get(service), dict) else {}
        profiles = []
        active_profile_id = bucket.get("active_profile_id")
        active_model_id = None
        for profile in bucket.get("profiles") or []:
            if not isinstance(profile, dict):
                continue
            profile_models = []
            for model in profile.get("models") or []:
                if not isinstance(model, dict):
                    continue
                model_id = str(model.get("id") or model.get("model") or "")
                if not model_id:
                    continue
                profile_models.append(
                    {
                        "id": model_id,
                        "name": str(model.get("name") or ""),
                        "model": str(model.get("model") or ""),
                    }
                )
            profile_id = str(profile.get("id") or "")
            if profile_id == active_profile_id and profile_models:
                active_model_id = str(
                    profile.get("active_model_id") or profile_models[0]["id"]
                )
            profiles.append(
                {
                    "id": profile_id,
                    "name": str(profile.get("name") or ""),
                    "binding": str(profile.get("binding") or profile.get("provider") or ""),
                    "models": profile_models,
                }
            )
        models[service] = {
            "active_profile_id": active_profile_id,
            "active_model_id": active_model_id,
            "profiles": profiles,
        }
    return {"generated_at": _now(), "models": models, "mcp": []}
