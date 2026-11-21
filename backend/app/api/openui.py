"""OpenUI server-side proxy endpoints (image search, street routing, Wikipedia)."""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any
from urllib.parse import quote, unquote

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/openui", tags=["openui"])

_HEADERS = {
    "User-Agent": "open-intelligent-ui (https://github.com/thesysdev/open-intelligent-ui)"
}
_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600, s-maxage=86400"}

_SKIP_IMAGE_RE = re.compile(
    r"\.svg|icon|logo|map|flag|seal|coat_of_arms|signature|diagram",
    re.IGNORECASE,
)
_SKIP_WIKI_RE = re.compile(r"\.svg|icon|logo|map|flag|seal", re.IGNORECASE)
_IMAGE_WIDTH = 960
_MAX_STOPS = 25

class BoundedCache:
    """In-memory FIFO-bounded cache preserving insertion order."""

    def __init__(self, max_size: int) -> None:
        self._max_size = max_size
        self._data: dict[str, Any] = {}

    def get(self, key: str) -> Any | None:
        return self._data.get(key)

    def set(self, key: str, value: Any) -> None:
        if key not in self._data and len(self._data) >= self._max_size:
            self._data.pop(next(iter(self._data)))
        self._data[key] = value


_image_cache = BoundedCache(500)
_route_cache = BoundedCache(200)
_wiki_cache = BoundedCache(500)


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[^\w]+", text.lower()) if len(w) > 3]


async def _wiki_query(
    client: httpx.AsyncClient, host: str, params: dict[str, str]
) -> list[dict[str, Any]]:
    resp = await client.get(
        f"https://{host}/w/api.php",
        params={"action": "query", "format": "json", "formatversion": "2", **params},
        headers=_HEADERS,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise RuntimeError(f"{host} error")
    pages = (data.get("query") or {}).get("pages") or []
    return sorted(pages, key=lambda p: p.get("index", 0))


async def _search_images(q: str) -> list[str]:
    images: list[str] = []

    def add(url: str | None) -> None:
        if (
            url
            and url.startswith("https://")
            and not _SKIP_IMAGE_RE.search(url)
            and url not in images
        ):
            images.append(url)

    wanted = set(_words(q))
    async with httpx.AsyncClient(timeout=8.0) as client:
        articles = await _wiki_query(
            client,
            "en.wikipedia.org",
            {
                "generator": "search",
                "gsrsearch": q,
                "gsrlimit": "6",
                "prop": "pageimages",
                "piprop": "thumbnail",
                "pithumbsize": str(_IMAGE_WIDTH),
            },
        )
        for page in articles:
            if any(w in wanted for w in _words(page.get("title") or "")):
                add((page.get("thumbnail") or {}).get("source"))

        terms = q.split()
        tries = list(
            dict.fromkeys(
                [
                    " ".join(terms),
                    " ".join(terms[:3]),
                    " ".join(terms[:2]),
                ]
            )
        )
        for term in tries:
            if len(images) >= 3:
                break
            files = await _wiki_query(
                client,
                "commons.wikimedia.org",
                {
                    "generator": "search",
                    "gsrsearch": f"{term} filetype:bitmap",
                    "gsrnamespace": "6",
                    "gsrlimit": "6",
                    "prop": "imageinfo",
                    "iiprop": "url|mime",
                    "iiurlwidth": str(_IMAGE_WIDTH),
                },
            )
            for page in files:
                info = (page.get("imageinfo") or [None])[0]
                if info and str(info.get("mime") or "").startswith("image/"):
                    add(info.get("thumburl") or info.get("url"))

    return images[:4]


@router.get("/image-search")
async def image_search(q: str = Query(default="")) -> JSONResponse:
    cleaned = re.sub(r"\s+", " ", q).strip()
    if len(cleaned) < 2 or len(cleaned) > 200:
        return JSONResponse(
            {"error": {"message": "q must be 2 to 200 characters"}}, status_code=400
        )
    images = _image_cache.get(cleaned)
    if images is None:
        try:
            images = await _search_images(cleaned)
        except Exception:  # noqa: BLE001
            return JSONResponse(
                {"error": {"message": "Image search unavailable"}}, status_code=502
            )
        _image_cache.set(cleaned, images)
    return JSONResponse({"images": images}, headers=_CACHE_HEADERS)


def parse_coords(coords: str) -> list[tuple[float, float]] | None:
    """Parse ``lng,lat;lng,lat;...`` into 2–25 valid finite coordinate pairs."""
    raw_pairs = coords.split(";") if coords else []
    if len(raw_pairs) < 2 or len(raw_pairs) > _MAX_STOPS:
        return None
    points: list[tuple[float, float]] = []
    for pair in raw_pairs:
        parts = pair.split(",")
        if len(parts) != 2:
            return None
        try:
            lng, lat = float(parts[0]), float(parts[1])
        except ValueError:
            return None
        if (
            not math.isfinite(lng)
            or not math.isfinite(lat)
            or abs(lng) > 180
            or abs(lat) > 90
        ):
            return None
        points.append((lng, lat))
    return points


@router.get("/street-route")
async def street_route(coords: str = Query(default="")) -> JSONResponse:
    points = parse_coords(coords)
    if points is None:
        return JSONResponse(
            {"error": {"message": f"coords must be 2–{_MAX_STOPS} lng,lat pairs"}},
            status_code=400,
        )

    key = ";".join(f"{lng:g},{lat:g}" for lng, lat in points)
    route = _route_cache.get(key)
    if route is None:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"https://router.project-osrm.org/route/v1/driving/{key}",
                    params={
                        "overview": "full",
                        "geometries": "geojson",
                        "steps": "false",
                    },
                    headers=_HEADERS,
                )
                resp.raise_for_status()
                data = resp.json()
            coordinates = (
                ((data.get("routes") or [{}])[0].get("geometry") or {}).get(
                    "coordinates"
                )
                or []
            )
            if data.get("code") != "Ok" or len(coordinates) < 2:
                raise RuntimeError("No street route")
            route = [[lat, lng] for lng, lat in coordinates]
            _route_cache.set(key, route)
        except Exception:  # noqa: BLE001
            return JSONResponse(
                {"error": {"message": "Street routing unavailable"}}, status_code=502
            )
    return JSONResponse({"points": route}, headers=_CACHE_HEADERS)


async def _wiki_get(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    resp = await client.get(url, headers=_HEADERS)
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    return resp.json()


def _photo_key(url: str) -> str:
    filename = unquote(url.split("?")[0].rsplit("/", 1)[-1])
    return re.sub(r"^\d+px-", "", filename)


async def wiki_photos(title: str) -> dict[str, Any]:
    """Lead + media-list photos and coordinates for an exact article title."""
    encoded = quote(title.replace(" ", "_"), safe="")
    async with httpx.AsyncClient(timeout=8.0) as client:
        summary, media = await asyncio.gather(
            _wiki_get(
                client,
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}",
            ),
            _wiki_get(
                client,
                f"https://en.wikipedia.org/api/rest_v1/page/media-list/{encoded}",
            ),
        )
    photos: list[str] = []
    seen_keys: set[str] = set()
    lead = (summary.get("thumbnail") or {}).get("source")
    if lead:
        photos.append(lead)
        seen_keys.add(_photo_key(lead))
    for item in media.get("items") or []:
        srcset = item.get("srcset") or []
        if item.get("type") != "image" or not srcset:
            continue
        src = str(srcset[0].get("src") or "")
        if not src or _SKIP_WIKI_RE.search(src):
            continue
        url = f"https:{src}" if src.startswith("//") else src
        k = _photo_key(url)
        if k not in seen_keys:
            photos.append(url)
            seen_keys.add(k)
        if len(photos) >= 3:
            break
    coords = summary.get("coordinates") or {}
    info: dict[str, Any] = {"photos": photos}
    if coords.get("lat") is not None:
        info["lat"] = coords["lat"]
    if coords.get("lon") is not None:
        info["lng"] = coords["lon"]
    return info


async def search_images(query: str) -> list[str]:
    """Fuzzy image URLs for a free-text query (Wikipedia + Commons)."""
    return await _search_images(query)


@router.get("/wiki")
async def wiki_lookup(title: str = Query(default="")) -> JSONResponse:
    cleaned = title.strip()
    if not cleaned or len(cleaned) > 200:
        return JSONResponse(
            {"error": {"message": "title is required"}}, status_code=400
        )
    info = _wiki_cache.get(cleaned)
    if info is None:
        try:
            info = await wiki_photos(cleaned)
            _wiki_cache.set(cleaned, info)
        except Exception:  # noqa: BLE001
            return JSONResponse(
                {"error": {"message": "Wikipedia unavailable"}}, status_code=502
            )
    return JSONResponse(info, headers=_CACHE_HEADERS)
