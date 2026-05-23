"""
Letterboxd scraping sidecar.

The Cloudflare bypass relies on curl_cffi's Chrome TLS-fingerprint
impersonation. Every outbound request to letterboxd.com MUST go through
the shared `session` below, or the request will be flagged by Cloudflare
and return 403.

The endpoint shapes mirror the existing Node side one-for-one so the
Node service can swap its HTTP client out without changing any
downstream code (Radarr transform, Redis cache, chunked-JSON).
"""

from __future__ import annotations

import logging
import re
from typing import Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from curl_cffi import requests as curl_requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

LETTERBOXD_ORIGIN = "https://letterboxd.com"
IMPERSONATE_TARGET = "chrome"

NEXT_PAGE_RE = re.compile(r"/page/(\d+)")
IMDB_RE = re.compile(r"imdb\.com/title/(.*?)(?:/|$)", re.IGNORECASE)
TMDB_RE = re.compile(r"themoviedb\.org/movie/(.*?)(?:/|$)")
YEAR_RE = re.compile(r"(\d{4})")

POSTER_SELECTOR = (
    ".posteritem > .react-component, "
    '[data-component-class*="LazyPoster"], '
    '.poster-list [data-poster-url*="film"], '
    '.poster-grid [data-poster-url*="film"]'
)

logger = logging.getLogger("letterboxd-sidecar")

app = FastAPI(title="letterboxd-sidecar")

session = curl_requests.Session(impersonate=IMPERSONATE_TARGET)


def fetch_html(url: str) -> str:
    response = session.get(url, allow_redirects=True)
    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"letterboxd.com returned {response.status_code} for {url}",
        )
    return response.text


def first_attr(el, *attrs: str) -> str:
    for attr in attrs:
        value = el.get(attr)
        if value:
            return value.strip()
    return ""


def extract_next_page(soup: BeautifulSoup) -> str:
    link = soup.select_one(".paginate-nextprev .next")
    if not link:
        return ""
    href = link.get("href") or ""
    match = NEXT_PAGE_RE.search(href)
    return match.group(1) if match else ""


def extract_posters(soup: BeautifulSoup) -> list[dict]:
    posters: list[dict] = []
    for el in soup.select(POSTER_SELECTOR):
        slug = first_attr(el, "data-target-link", "data-poster-url")
        if not slug:
            link = el.select_one("a[href*='/film/']")
            if link:
                slug = link.get("href") or ""
        title = first_attr(el, "data-item-name", "data-film-name", "alt")
        if not title:
            img = el.select_one("img[alt]")
            if img:
                title = img.get("alt") or ""
        if slug:
            posters.append({"slug": slug.strip(), "title": title.strip()})
    return posters


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/list")
def list_endpoint(
    slug: str = Query(..., description="Path on letterboxd.com, e.g. /user/watchlist/"),
    page: int = Query(1, ge=1),
) -> dict:
    """Generic list/watchlist scraper. Mirrors lib/letterboxd/list.ts."""
    url = f"{LETTERBOXD_ORIGIN}{slug}page/{page}/"
    html = fetch_html(url)
    soup = BeautifulSoup(html, "lxml")
    return {
        "next": extract_next_page(soup),
        "posters": extract_posters(soup),
    }


@app.get("/collection")
def collection_endpoint(path: str = Query(..., description="e.g. /films/in/halloween-collection/")) -> dict:
    """Two-step collection scrape mirroring lib/letterboxd/collection.ts."""
    front_html = fetch_html(f"{LETTERBOXD_ORIGIN}{path}")
    front = BeautifulSoup(front_html, "lxml")
    container = front.select_one("#films-browser-list-container")
    if not container or not container.get("data-url"):
        raise HTTPException(status_code=404, detail="Collection ajax URL not found")
    ajax_url = urljoin(LETTERBOXD_ORIGIN, container.get("data-url"))

    ajax_html = fetch_html(ajax_url)
    ajax = BeautifulSoup(ajax_html, "lxml")

    posters: list[dict] = []
    # Match the original TS selectors: .poster-list .film-poster, slug from data-target-link, title from img alt.
    for el in ajax.select(".poster-list .film-poster"):
        slug = first_attr(el, "data-target-link", "data-film-slug")
        title = ""
        img = el.select_one(".image, img")
        if img is not None:
            title = img.get("alt") or ""
        if slug:
            posters.append({"slug": slug.strip(), "title": title.strip()})

    # Fallback: some collection pages now use the same poster grid as regular lists.
    if not posters:
        posters = extract_posters(ajax)
    return {"posters": posters}


@app.get("/films-popular")
def films_popular_endpoint(
    slug: str = Query(..., description="e.g. /films/popular/ or /films/popular/this/week/"),
    page: int = Query(1, ge=1),
) -> dict:
    """One page of /films/popular/...; the Node side iterates pages."""
    path = re.sub(r"^/films", "", slug)
    url = f"{LETTERBOXD_ORIGIN}/films/ajax/{path}page/{page}/"
    html = fetch_html(url)
    soup = BeautifulSoup(html, "lxml")
    return {"posters": extract_posters(soup)}


@app.get("/tagged-lists")
def tagged_lists_endpoint(
    path: str = Query(..., description="e.g. /user/tag/horror/lists/"),
    page: int = Query(1, ge=1),
) -> dict:
    """One page of a user's tagged-lists index. Mirrors lib/letterboxd/tagged-lists.ts."""
    url = f"{LETTERBOXD_ORIGIN}{path}page/{page}/"
    html = fetch_html(url)
    soup = BeautifulSoup(html, "lxml")

    lists: list[dict] = []
    for entry in soup.select(".list-set .list"):
        anchor = entry.select_one("a")
        title_el = entry.select_one("h2")
        count_el = entry.select_one(".attribution .value")
        slug = (anchor.get("href") or "").strip() if anchor else ""
        title = title_el.get_text(strip=True) if title_el else ""
        count_text = count_el.get_text(strip=True) if count_el else ""
        count_match = re.search(r"(\d+)", count_text)
        movies_count = count_match.group(1) if count_match else ""
        if slug:
            lists.append({"slug": slug, "title": title, "moviesCount": movies_count})

    return {
        "next": extract_next_page(soup),
        "lists": lists,
    }


@app.get("/movie")
def movie_endpoint(slug: str = Query(..., description="e.g. /film/the-thing/")) -> dict:
    """Single movie page, with TMDB/IMDB id extraction. Mirrors lib/letterboxd/movie-details.ts."""
    url = f"{LETTERBOXD_ORIGIN}{slug}"
    html = fetch_html(url)
    soup = BeautifulSoup(html, "lxml")

    name_el = soup.select_one(".headline-1") or soup.select_one("h1.headline-1")
    name = name_el.get_text(strip=True) if name_el else ""

    year_el = soup.select_one("a[href^='/films/year']")
    published = ""
    if year_el is not None:
        match = YEAR_RE.search(year_el.get_text())
        if match:
            published = match.group(1)

    imdb_link = soup.select_one("[data-track-action='IMDb'], [data-track-action='imdb']")
    tmdb_link = soup.select_one("[data-track-action='TMDb'], [data-track-action='tmdb']")

    def extract_id(el, pattern: re.Pattern[str]) -> Optional[str]:
        if el is None:
            return None
        href = el.get("href") or ""
        match = pattern.search(href)
        return match.group(1) if match else None

    imdb = extract_id(imdb_link, IMDB_RE) or ""
    tmdb = extract_id(tmdb_link, TMDB_RE) or ""

    return {
        "slug": slug,
        "name": name,
        "published": published,
        "imdb": imdb,
        "tmdb": tmdb,
    }


@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
