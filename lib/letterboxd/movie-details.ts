import pLimit from "p-limit";
import { sidecar } from "../sidecar/client";
import * as cache from "../cache/index";
import { InflightDedup } from "../cache/inflight";
import { logger } from "../logger";

const moviesLogger = logger.child({ module: "MoviesDetails" });

const inflightMovieDetail = new InflightDedup<LetterboxdMovieDetails>();

export interface LetterboxdMovieDetails {
    slug: string;
    name: string;
    published: string;
    imdb: string;
    tmdb?: string;
}

export const getMoviesDetailCached = async (
    slugs: string[],
    concurrencyLimit: number = 7,
    onDetail?: (movie: LetterboxdMovieDetails) => void
) => {
    // we have to remove empty entries to prevent infinite loading
    slugs = slugs.filter((slug) => slug);

    // Phase 1: stream every movie already in Redis first. Without this the
    // pLimit(7) pool below interleaves cached lookups with slow fresh fetches,
    // which means a client that times out at T seconds may receive only the
    // (random) subset of cached movies that happened to win pLimit slots.
    const cachedResults = await Promise.all(
        slugs.map(async (slug) => {
            try {
                if (await cache.has(slug)) {
                    return await cache.get<LetterboxdMovieDetails>(slug);
                }
            } catch {
                // Treat redis errors as cache miss; fall through to phase 2.
            }
            return null;
        })
    );

    const movies: LetterboxdMovieDetails[] = [];
    const uncachedSlugs: string[] = [];
    cachedResults.forEach((movie, i) => {
        if (movie) {
            movies.push(movie);
            if (onDetail) onDetail(movie);
        } else {
            uncachedSlugs.push(slugs[i]);
        }
    });

    // Phase 2: fetch the rest. Already-running fetches for the same slug are
    // coalesced by InflightDedup inside getCachedMovieDetail.
    const limit = pLimit(concurrencyLimit);
    const fresh = await Promise.all(
        uncachedSlugs.map(async (slug) => {
            const detail = await limit(async () => {
                try {
                    return await getCachedMovieDetail(slug);
                } catch (e: any) {
                    moviesLogger.error(`Error fetching '${slug}'.`);
                }
            });

            if (onDetail && detail) {
                onDetail(detail);
            }
            return detail;
        })
    );

    return [
        ...movies,
        ...fresh.filter((m): m is LetterboxdMovieDetails => !!m),
    ];
};

export const getMovieDetail = async (slug: string): Promise<LetterboxdMovieDetails> => {
    const data = await sidecar.getMovie(slug);
    return {
        slug,
        name: data.name,
        published: data.published,
        imdb: data.imdb,
        tmdb: data.tmdb || undefined,
    };
};

export const getCachedMovieDetail = async (slug: string) => {
    if (await cache.has(slug)) {
        moviesLogger.debug(`Fetched '${slug}' from redis.`);
        return await cache.get<LetterboxdMovieDetails>(slug);
    }

    return inflightMovieDetail.run(slug, async () => {
        const data = await getMovieDetail(slug);
        moviesLogger.debug(`Fetched '${slug}' live.`);
        // We cache movies indefinitely, assuming they don't change.
        // Be sure to configure redis with a maxmemory and an eviction policy or this will eat all your RAM
        await cache.set(slug, data);
        return data;
    });
};
