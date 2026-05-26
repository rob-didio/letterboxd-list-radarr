import pLimit from "p-limit";
import { LetterboxdPoster } from "./list";
import { sidecar } from "../sidecar/client";
import * as cache from "../cache/index";
import { InflightDedup } from "../cache/inflight";

const PAGE_LIMIT = 10;

// Cache popular for 120min
const CACHE_TIMEOUT = 120 * 60;

const inflightPopular = new InflightDedup<LetterboxdPoster[]>();

export const getCachedFilmsPopular = async (
    slug: string
): Promise<LetterboxdPoster[]> => {
    const cached = await cache.get(slug);
    if (cached && Array.isArray(cached)) {
        return cached;
    }
    if (cached !== undefined) {
        await cache.del(slug);
    }

    return inflightPopular.run(slug, async () => {
        const posters = await getFilmsPopular(slug);
        await cache.set(slug, posters, CACHE_TIMEOUT);
        return posters;
    });
};

export const getFilmsPopular = async (
    slug: string
): Promise<LetterboxdPoster[]> => {
    const pageNumbers = Array.from({ length: PAGE_LIMIT }, (_, i) => i + 1);
    const limit = pLimit(2);
    const posters: LetterboxdPoster[] = [];

    await Promise.all(
        pageNumbers.map(async (page) => {
            const result = await limit(() =>
                sidecar.getFilmsPopularPage(slug, page)
            );
            posters.push(...result.posters);
        })
    );

    return posters;
};
