import pLimit from "p-limit";
import { logger } from "../logger";
import { getListCached, LetterboxdPoster } from "./list";
import { sidecar } from "../sidecar/client";

interface LetterboxdTaggedList {
    slug: string;
    title: string;
    moviesCount: string;
}

export const getTaggedLists = async (taggedListSlug: string): Promise<LetterboxdPoster[]> => {
    const lists: LetterboxdTaggedList[] = [];
    const posters: LetterboxdPoster[] = [];

    let moviesCount = 0;

    let nextPage: number | null = 1;
    while (nextPage) {
        const result = await sidecar.getTaggedListsPage(taggedListSlug, nextPage);
        lists.push(...result.lists);
        moviesCount += result.lists.reduce((a, list) => a + Number.parseInt(list.moviesCount), 0);
        nextPage = Number.parseInt(result.next);
        nextPage = Number.isNaN(nextPage) ? null : nextPage;
    }
    logger.debug(`Tagged Lists contain ${moviesCount} movies.`);

    const limit = pLimit(2);
    await Promise.all(lists.map(async (list) => {
        const listPosters = await limit(() => getListCached(list.slug));
        logger.debug(`Fetched List ${list.slug}.`);
        posters.push(...listPosters);
    }));

    return posters;
};
