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
    const limit = pLimit(concurrencyLimit);
    const movies = await Promise.all(
        slugs.map(async (slug) => {
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
    return movies.filter((movie): movie is LetterboxdMovieDetails => !!movie);
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
