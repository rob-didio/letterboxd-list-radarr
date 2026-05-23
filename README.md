# letterboxd-list-radarr

Connect radarr to letterboxd.com lists.

> ## Heads up — read before deploying
>
> In mid-January 2026 letterboxd.com put the site behind Cloudflare bot
> protection, which blocks the original axios scraper with HTTP 403
> "Just a moment..." challenges. In December 2025 letterboxd also
> added clause 6.11 to their Terms of Service, which explicitly
> prohibits scraping. The upstream project (issue #64) declared itself
> unusable as a result.
>
> This fork keeps the project working **for personal self-hosted use only**
> by adding a Python sidecar (`sidecar/`) that uses [`curl_cffi`](https://github.com/yifeikong/curl_cffi)'s
> Chrome TLS-fingerprint impersonation to get past Cloudflare. **Do not
> run a public hosted instance** — that's the part of the original
> deployment that's no longer acceptable under letterboxd's ToS.

## Usage

### Radarr v3 and up

1. Configure a new list in radarr, using the _Custom Lists_ provider.
2. Set _List URL_ to the base URL of your self-hosted instance followed by the path to your list in letterboxd. For example: `http://your-host:5000/screeny05/list/jackie-chan-the-definitive-list/`
3. Configure the rest of the settings to your liking
4. Test & Save.

### Radarr v2

1. Configure a new list in radarr, using the _Radarr Lists_ provider.
2. Set _Radarr API URL_ to the base URL of your self-hosted instance.
3. Set _Path to list_ to whatever appears in the URL for the list of your choosing after `letterboxd.com`.

### Supported Lists:

-   Watchlists: https://letterboxd.com<b>/screeny05/watchlist/</b>
-   Regular Lists: https://letterboxd.com<b>/screeny05/list/jackie-chan-the-definitive-list/</b>
-   Watched Movies: https://letterboxd.com<b>/screeny05/films/</b>
-   Filmography:
    -   Actor: https://letterboxd.com<b>/actor/tom-hanks/</b>
    -   Director: https://letterboxd.com<b>/director/alfred-hitchcock/</b>
    -   Writer: https://letterboxd.com<b>/writer/charlie-kaufman/</b>
    -   Etc.
-   Collections: https://letterboxd.com<b>/films/in/halloween-collection/</b>
-   Popular Movies: https://letterboxd.com<b>/films/popular/</b>
    -   Note that neither filtering nor sorting is allowed according to the robots.txt. So URLs like /films/popular/genre/action, /films/popular/decade/2020s /films/by/release, etc. are not supported
    -   This list is limited to 10 pages, so a maximum of 720 movies are returned. You can limit this number with the `limit`-option
-   Lists tagged by User are not supported. Please use links to the lists themself instead.

Others may be supported, but are not tested, yet.

### Supported options

This is a list of all options you can provide to this scraper, You can set them by attaching a get-parameter to the URL like this:

`/actor/tom-hanks/?<key>=<value>`

Where `key` is the name of the option and `value` is the value you want to provide.

The following options are currently supported:

-   `limit` - Return only a maximum number of movies. This is useful for very large lists like /films/popular/
-   `errorOnEmpty` - The API will return a 404 error if the list is empty. If set to `false`, the API will return an empty list instead. Defaults to `true`.

## Architecture

```
Radarr ──HTTP──▶ Node service (this repo, port 5000)
                      │
                      │  internal HTTP via LB_SIDECAR_URL (default http://localhost:5001)
                      ▼
                 Python sidecar (sidecar/, FastAPI + curl_cffi)
                      │
                      ▼
                 letterboxd.com  (Cloudflare-protected)
```

The Node service still does routing, Radarr-shape transformation, Redis
caching, and chunked-JSON streaming. The Python sidecar is the only
process that talks to letterboxd.com — it uses `curl_cffi.requests.Session(impersonate="chrome")`
to spoof Chrome's JA3/JA4 TLS fingerprint, which is what Cloudflare's
automated check actually keys on.

## Self-hosting

> Reminder: personal use only. Do not run a public hosted instance.

### Using docker-compose (recommended)

```
git clone git@github.com:rob-didio/letterboxd-list-radarr.git
cd letterboxd-list-radarr
docker-compose up -d --build
```

This starts three containers: the Node web service (port 5000), the
Python sidecar (port 5001), and redis. Your local instance will be
available at `http://localhost:5000`.

The `redis.conf` file can be used to configure your own redis settings. It
comes with a memory-limit of 256mb by default — increase based on usage.

### Single-image build

The root `Dockerfile` packages the Node app and Python sidecar into one
image (using supervisord to run both processes) for hosting platforms
that only deploy a single container. This is convenient but couples the
two processes' lifecycles — the docker-compose split is preferred.

### Render / Heroku

`render.yaml` is provided as a starting point — it declares the Node
web service, the Python sidecar (as a second Docker web service rooted
in `sidecar/`), and a redis instance, and wires `LB_SIDECAR_URL` from
the sidecar's internal hostname. You will need to fork this repo and
point Render at your fork.

If using a redis with limited memory, set the correct eviction policy:

```
heroku redis:maxmemory <name-of-redis-instance> --policy allkeys-lfu
```

### Local & development

You need a working redis-instance, which is used for caching movie- & list-data.

Following environment-params are supported:

-   `REDIS_URL` - A [redis connection string](https://github.com/ServiceStack/ServiceStack.Redis#redis-connection-strings) to your redis-instance
-   `LB_SIDECAR_URL` - Base URL of the Python sidecar that talks to letterboxd. Defaults to `http://localhost:5001`
-   `PORT` - The http-port which the application listens on
-   `LOG_LEVEL` - Set to `debug` for more info. Defaults to `info`

You'll need both the Node service and the Python sidecar running:

```bash
# Terminal 1 — sidecar
cd sidecar
pip install .
uvicorn app:app --port 5001

# Terminal 2 — Node service (in repo root)
npm install
LB_SIDECAR_URL=http://localhost:5001 npm run watch
```

Or just `docker-compose up` to bring up all three services (web + sidecar + redis).
