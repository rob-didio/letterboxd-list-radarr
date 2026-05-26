import { LetterboxdPoster } from "./list";
import { sidecar } from "../sidecar/client";

export const getCollection = async (
    collectionSlug: string
): Promise<LetterboxdPoster[]> => {
    const { posters } = await sidecar.getCollection(collectionSlug);
    return posters;
};
