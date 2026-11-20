"""Tests for the DeepTutor-owned provider/model configuration layer."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import provider_config as pc
from app.config import Settings


def make_settings() -> Settings:
    return Settings(data_dir=Path(tempfile.mkdtemp()))


class SelectionTests(unittest.TestCase):
    def test_selection_round_trip_and_recency(self) -> None:
        settings = make_settings()
        self.assertIsNone(pc.get_selection(settings))

        saved = pc.set_selection(settings, {"profile_id": "openai", "model_id": "gpt-4o"})
        assert saved is not None
        self.assertEqual(saved["profile_id"], "openai")
        selection = pc.get_selection(settings)
        assert selection is not None
        self.assertEqual(selection["model_id"], "gpt-4o")
        self.assertIn(("openai", "gpt-4o"), pc.recent_pairs(settings))

        # The selection is also stored under its own key in the shared DB.
        from app.store import database

        stored = database.get_state(settings, "settings/selection")
        self.assertEqual(stored["llm_selection"]["model_id"], "gpt-4o")

        # Explicit override wins, without changing the persisted selection.
        override = pc.get_selection(settings, {"profile_id": "x", "model_id": "y"})
        assert override is not None
        self.assertEqual(override["profile_id"], "x")
        selection = pc.get_selection(settings)
        assert selection is not None
        self.assertEqual(selection["profile_id"], "openai")

    def test_recency_is_capped_and_deduped(self) -> None:
        settings = make_settings()
        for i in range(25):
            pc.set_selection(settings, {"profile_id": "p", "model_id": f"m{i}"})
        pc.set_selection(settings, {"profile_id": "p", "model_id": "m24"})
        recent = pc.recent_pairs(settings)
        self.assertEqual(len(recent), pc._RECENT_LIMIT)
        self.assertEqual(len([r for r in recent if r == ("p", "m24")]), 1)


class CatalogTests(unittest.TestCase):
    def test_unconfigured_preset_models_stay_out_of_chat_options(self) -> None:
        settings = make_settings()
        # A fresh install has no saved models and no recency: built-in presets
        # must not fill the composer with OpenAI/Gemini/xAI models.
        self.assertEqual(pc.model_options(settings), [])

        pc.set_selection(settings, {"profile_id": "wusrouter", "model_id": "codex/gpt-5:free"})
        options = pc.model_options(settings)
        self.assertEqual([o["model"] for o in options], ["codex/gpt-5:free"])
        self.assertTrue(options[0]["is_recent"])

    def test_saved_profile_is_source_of_truth_for_options(self) -> None:
        settings = make_settings()
        catalog = pc.load_catalog(settings)
        catalog["services"]["llm"]["profiles"].append({
            "id": "my-profile",
            "name": "My Gateway",
            "binding": "my-gateway",
            "base_url": "https://gw.example/v1",
            "api_key": "sk-test",
            "api_format": "anthropic",
            "models": [{
                "id": "my-model",
                "name": "My Model",
                "model": "wire-model-1",
                "capabilities": {"vision": True, "reasoning": True},
                "context_window_tokens": 128000,
                "reasoning_effort": "high",
            }],
        })
        pc.save_catalog(settings, catalog)
        pc.set_selection(settings, {"profile_id": "my-profile", "model_id": "my-model"})

        options = pc.model_options(settings)
        opt = next(o for o in options if o["profile_id"] == "my-profile")
        self.assertEqual(opt["model_name"], "My Model")
        self.assertEqual(opt["context_window"], 128000)
        self.assertTrue(opt["supports_vision"])
        self.assertTrue(opt["is_active_default"])

        resolved = pc.resolve_runtime_model(settings)
        self.assertEqual(resolved["provider"], "anthropic")  # api_format forces wire protocol
        self.assertEqual(resolved["model"], "wire-model-1")
        self.assertEqual(resolved["base_url"], "https://gw.example/v1")
        self.assertEqual(resolved["api_key"], "sk-test")
        self.assertEqual(resolved["thinking_level"], "high")
        self.assertEqual(resolved["source"], "profile:my-profile")

    def test_synced_profile_models_show_real_names_and_resolve_credentials(self) -> None:
        """Settings-created model ids are opaque; show the real model and use
        the connection linked from the model's provider_ref."""
        settings = make_settings()
        catalog = pc.load_catalog(settings)
        catalog["connections"].append({
            "id": "c1", "name": "Kilo Gateway", "provider": "kilo",
            "api_key": "sk-kilo", "base_url": "https://api.kilo.ai/api/gateway",
            "api_version": "",
        })
        catalog["services"]["llm"]["profiles"].append({
            "id": "llm-profile-1", "name": "Kilo Gateway", "binding": "kilo",
            "base_url": "", "api_key": "",
            "models": [{
                "id": "llm-model-1", "name": "kilo-auto/free", "model": "kilo-auto/free",
                "provider_ref": {"connection_id": "c1", "binding": "kilo"},
            }],
        })
        pc.save_catalog(settings, catalog)

        option = next(
            o for o in pc.model_options(settings)
            if o["profile_id"] == "llm-profile-1"
        )
        self.assertEqual(option["model"], "kilo-auto/free")
        self.assertEqual(option["model_name"], "kilo-auto/free")
        self.assertEqual(option["provider"], "kilo")
        self.assertEqual(option["provider_label"], "Kilo Gateway")

        resolved = pc.resolve_runtime_model(settings, {"llm_selection": {
            "profile_id": "llm-profile-1", "model_id": "llm-model-1",
        }})
        self.assertEqual(resolved["provider"], "kilo")
        self.assertEqual(resolved["model"], "kilo-auto/free")
        self.assertEqual(resolved["base_url"], "https://api.kilo.ai/api/gateway")
        self.assertEqual(resolved["api_key"], "sk-kilo")

    def test_preset_fallback_uses_env_key(self) -> None:
        settings = make_settings()
        pc.set_selection(settings, {"profile_id": "anthropic", "model_id": "claude-3-7-sonnet-20250219"})
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-ant-test"}):
            resolved = pc.resolve_runtime_model(settings)
        self.assertEqual(resolved["provider"], "anthropic")
        self.assertEqual(resolved["api_key"], "sk-ant-test")
        self.assertEqual(resolved["source"], "preset:anthropic")

    def test_no_vtx_files_are_created(self) -> None:
        settings = make_settings()
        pc.set_selection(settings, {"profile_id": "openai", "model_id": "gpt-4o"})
        pc.model_options(settings)
        pc.provider_options(settings)
        pc.connection_targets(settings)
        pc.resolve_runtime_model(settings)
        # Everything persistent is in the one database; no per-store files.
        names = {p.name for p in settings.data_dir.iterdir()}
        self.assertEqual(names, {"deeptutor.sqlite3"})


class CatalogFileTests(unittest.TestCase):
    def test_builtin_catalog_contains_all_providers(self) -> None:
        presets = pc.builtin_presets()
        self.assertGreaterEqual(len(presets), 60)
        for slug in (
            "openai", "anthropic", "zhipu", "opengateway", "experientiallabs",
            "kilo", "aihubmix", "ollama", "aerolink", "fastrouter", "xai",
            "conduit", "sarvam", "bai", "wusrouter",
        ):
            self.assertIn(slug, presets)
        self.assertEqual(presets["zhipu"]["api_key_env"], "ZAI_API_KEY")
        self.assertEqual(presets["zhipu"]["base_url"], "https://api.z.ai/api/coding/paas/v4")
        self.assertEqual(presets["experientiallabs"]["model_parser"]["id_field"], "slug")


class ProbeTests(unittest.TestCase):
    def test_custom_models_parser(self) -> None:
        preset = pc.builtin_preset("experientiallabs")
        assert preset is not None
        payload = {"model": [{
            "slug": "m1",
            "display_name": "Model One",
            "context_window": 128000,
        }]}
        rows = pc._extract_models(payload, preset["model_parser"])
        self.assertEqual(rows, [{"id": "m1", "name": "Model One", "context_window": 128000}])

    def test_preset_models_endpoint_is_used(self) -> None:
        response = mock.Mock(status_code=200)
        response.json.return_value = {"data": [{"id": "m1"}]}
        preset = pc.builtin_preset("experientiallabs")
        assert preset is not None
        with mock.patch("httpx.Client") as client_cls:
            client = client_cls.return_value.__enter__.return_value
            client.get.return_value = response
            pc.probe_models(preset["base_url"], "k", "openai_chat", preset)
        self.assertEqual(
            client.get.call_args.args[0],
            "https://api.experientiallabs.ai/api/models",
        )

    def test_parse_openai_models_response(self) -> None:
        response = mock.Mock(status_code=200)
        response.json.return_value = {"data": [{"id": "a"}, {"id": "b"}, {"id": "a"}]}
        with mock.patch("httpx.Client") as client_cls:
            client = client_cls.return_value.__enter__.return_value
            client.get.return_value = response
            result = pc.probe_models("https://gw.example/v1", "sk-x")
        self.assertEqual(result["status"], "connected")
        self.assertEqual([m["id"] for m in result["models"]], ["a", "b"])
        headers = client.get.call_args.kwargs["headers"]
        self.assertEqual(headers["Authorization"], "Bearer sk-x")
        self.assertEqual(client.get.call_args.args[0], "https://gw.example/v1/models")

    def test_invalid_url_short_circuits(self) -> None:
        result = pc.probe_models("ftp://bad")
        self.assertEqual(result["status"], "invalid_url")
        self.assertEqual(result["models"], [])

    def test_large_model_list_is_not_truncated(self) -> None:
        """Gateways like Kilo publish more than 200 models; return them all."""
        expected = [f"model-{i}" for i in range(250)]
        response = mock.Mock(status_code=200)
        response.json.return_value = {"data": [{"id": mid} for mid in expected]}
        with mock.patch("httpx.Client") as client_cls:
            client = client_cls.return_value.__enter__.return_value
            client.get.return_value = response
            result = pc.probe_models("https://gw.example/v1", "sk-x")
        self.assertEqual(result["status"], "connected")
        self.assertEqual([m["id"] for m in result["models"]], expected)

    def test_discovered_models_are_stored_in_catalog(self) -> None:
        settings = make_settings()
        catalog = pc.load_catalog(settings)
        catalog["connections"].append({
            "id": "c1", "name": "GW", "provider": "my-gw",
            "api_key": "k", "base_url": "https://gw.example/v1", "api_version": "",
        })
        pc.save_catalog(settings, catalog)
        pc.store_discovered_models(settings, "my-gw", ["m1"], connection_id="c1")
        stored = pc.load_catalog(settings)["connections"][0]["discovery"]
        self.assertEqual([m["id"] for m in stored["models"]], ["m1"])
        self.assertEqual(stored["status"], "connected")


if __name__ == "__main__":
    unittest.main()
