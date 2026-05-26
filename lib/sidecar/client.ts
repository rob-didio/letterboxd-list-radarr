import Axios, { AxiosInstance } from "axios";
import { logger } from "../logger";

const SIDECAR_URL =
    process.env.LB_SIDECAR_URL?.replace(/\/+$/, "") || "http://localhost:5001";

const sidecarLogger = logger.child({ module: "SidecarClient" });

const instance: AxiosInstance = Axios.create({
    baseURL: SIDECAR_URL,
    // Letterboxd pages can be slow; the sidecar additionally does TLS impersonation.
    timeout: 30_000,
    validateStatus: (status) => status >= 200 && status < 300,
});

instance.interceptors.response.use(
    (r) => r,
    (err) => {
        const url = err?.config?.url;
        const status = err?.response?.status;
        const detail = err?.response?.data?.error ?? err?.message;
        sidecarLogger.error(
            `Sidecar request failed (${status ?? "no response"}) ${url}: ${detail}`
        );
        return Promise.reject(err);
    }
);

export interface SidecarPoster {
    slug: string;
    title: string;
}

export interface SidecarListPage {
    next: string;
    posters: SidecarPoster[];
}

export interface SidecarCollection {
    posters: SidecarPoster[];
}

export interface SidecarPopularPage {
    posters: SidecarPoster[];
}

export interface SidecarTaggedListEntry {
    slug: string;
    title: string;
    moviesCount: string;
}

export interface SidecarTaggedListsPage {
    next: string;
    lists: SidecarTaggedListEntry[];
}

export interface SidecarMovie {
    slug: string;
    name: string;
    published: string;
    imdb: string;
    tmdb: string;
}

export const sidecar = {
    async getList(slug: string, page: number): Promise<SidecarListPage> {
        const { data } = await instance.get<SidecarListPage>("/list", {
            params: { slug, page },
        });
        return data;
    },
    async getCollection(path: string): Promise<SidecarCollection> {
        const { data } = await instance.get<SidecarCollection>("/collection", {
            params: { path },
        });
        return data;
    },
    async getFilmsPopularPage(
        slug: string,
        page: number
    ): Promise<SidecarPopularPage> {
        const { data } = await instance.get<SidecarPopularPage>(
            "/films-popular",
            { params: { slug, page } }
        );
        return data;
    },
    async getTaggedListsPage(
        path: string,
        page: number
    ): Promise<SidecarTaggedListsPage> {
        const { data } = await instance.get<SidecarTaggedListsPage>(
            "/tagged-lists",
            { params: { path, page } }
        );
        return data;
    },
    async getMovie(slug: string): Promise<SidecarMovie> {
        const { data } = await instance.get<SidecarMovie>("/movie", {
            params: { slug },
        });
        return data;
    },
};

export { SIDECAR_URL };
