import { LetterboxdPoster } from "./lib/letterboxd/list";
import express from "express";
import { normalizeSlug } from "./lib/letterboxd/util";
import { transformLetterboxdMovieToRadarr } from "./lib/radarr/transform";
import {
    getMoviesDetailCached,
    LetterboxdMovieDetails,
} from "./lib/letterboxd/movie-details";
import { sendChunkedJson } from "./lib/express/send-chunked-json";
import { fetchPostersFromSlug } from "./lib/letterboxd";
import { logger } from "./lib/logger";
import { cache } from "./lib/cache";

const appLogger = logger.child({ module: "App" });

const PORT = process.env.PORT || 5000;

// Maximum wall-clock time we'll spend filling a response before closing it
// with whatever we have. After that the underlying fetch continues in the
// background (warming Redis), and the next retry pulls more from cache.
//
// Default 90s: Radarr's HttpRequest.RequestTimeout is 100s, so we want to
// close the response cleanly with a valid `]` before Radarr declares the
// request dead. Override via RESPONSE_DEADLINE_MS env var.
const RESPONSE_DEADLINE_MS =
    Number.parseInt(process.env.RESPONSE_DEADLINE_MS || "") || 90_000;

const app = express();
const server = app.listen(PORT, () =>
    appLogger.info(`Listening on port ${PORT}`)
);

server.keepAliveTimeout = 78;

app.get("/", (_, res) => res.send("Use letterboxd.com path as path here."));

app.get("/favicon.ico", (_, res) => res.status(404).send());

app.get(/(.*)/, async (req, res) => {
    const slug = normalizeSlug(req.params[0]);
    const chunk = sendChunkedJson(res);

    // Track client connection state for logging only. We intentionally keep
    // fetching after the client disconnects so per-movie results land in the
    // Redis cache and the next retry (Radarr re-polls aggressively) finds them.
    let isClientConnected = true;
    let isFinished = false;
    req.connection.once("close", () => {
        isClientConnected = false;
        if (!isFinished) {
            appLogger.warn(
                `Client closed connection before finish for ${slug} — continuing fetch in background to warm cache.`
            );
        }
    });

    const limit = req.query.limit
        ? Number.parseInt(req.query.limit)
        : undefined;
    const errorOnEmpty = req.query.errorOnEmpty
        ? req.query.errorOnEmpty !== "false"
        : true;

    let posters: LetterboxdPoster[];

    try {
        appLogger.info(`Fetching posters for ${slug}`);
        posters = await fetchPostersFromSlug(slug);
        if (!Array.isArray(posters)) {
            throw new Error(`Fetching posters failed for ${slug}`);
        }
        if (limit) {
            posters = posters.slice(0, limit);
        }
        appLogger.debug(`Fetched ${posters.length} posters`);
    } catch (e: any) {
        isFinished = true;
        appLogger.error(`Failed to fetch posters for ${slug} - ${e?.message}`);
        chunk.fail(404, e?.message);
        return;
    }

    if (posters.length === 0 && errorOnEmpty) {
        isFinished = true;
        chunk.fail(
            404,
            "List is empty or letterboxd page structure has changed so we can't fetch the list anymore. To disable this error, set ?errorOnEmpty=false"
        );
        return;
    }

    const movieSlugs = posters.map((poster) => poster.slug);

    // Once the soft deadline fires we close the response with `]` so the
    // client gets a valid JSON array containing whatever streamed by then.
    // The fetch loop keeps running afterwards to warm Redis for the next
    // retry; further onMovie pushes are dropped via this flag.
    let responseClosed = false;
    let deadlineFired = false;
    const closeResponse = (reason: "done" | "deadline") => {
        if (responseClosed) return;
        responseClosed = true;
        if (reason === "deadline") {
            deadlineFired = true;
            appLogger.warn(
                `Response deadline (${RESPONSE_DEADLINE_MS}ms) reached for ${slug}; returning partial list and continuing fetch in background.`
            );
        }
        chunk.end();
    };
    const deadlineTimer = setTimeout(
        () => closeResponse("deadline"),
        RESPONSE_DEADLINE_MS
    );

    const onMovie = (movie: LetterboxdMovieDetails) => {
        // If there's no tmdb-id it may be a tv-show
        // radarr throws an error, if an entry is missing an id
        if (!movie.tmdb) {
            return;
        }
        if (deadlineFired) {
            return;
        }
        // chunk.push is a no-op once res.writable flips false, so this is safe
        // to keep calling after the client disconnects.
        chunk.push(transformLetterboxdMovieToRadarr(movie));
    };

    try {
        await getMoviesDetailCached(movieSlugs, 7, onMovie);
    } catch (e: any) {
        appLogger.error(`Failed to fetch movies for ${slug} - ${e?.message}`);
        clearTimeout(deadlineTimer);
        if (!responseClosed) {
            chunk.fail(404, e?.message);
            responseClosed = true;
        }
        return;
    }

    isFinished = true;
    clearTimeout(deadlineTimer);
    closeResponse("done");
    if (deadlineFired || !isClientConnected) {
        appLogger.info(`Background fetch for ${slug} finished; cache warmed.`);
    }
});

process.on("unhandledRejection", (reason) => {
    throw reason;
});

process.on("uncaughtException", (error) => {
    appLogger.error("Uncaught Exception", error);
    process.exit(1);
});
