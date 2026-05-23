/**
 * Coalesces concurrent cache-miss work for the same key into a single promise.
 *
 * Pattern: check Redis → on miss, call `dedup(key, fetcher)`. The first caller
 * runs the fetcher; concurrent callers for the same key await the same promise
 * and share the result. The entry is dropped once the work resolves (or rejects)
 * so the next caller goes through the Redis check again.
 *
 * This is what stops "Radarr disconnected, then immediately retried" from
 * doubling the letterboxd hit while the original background fetch is still
 * running.
 */
export class InflightDedup<T> {
    private readonly map = new Map<string, Promise<T>>();

    async run(key: string, work: () => Promise<T>): Promise<T> {
        const existing = this.map.get(key);
        if (existing) {
            return existing;
        }

        const promise = work().finally(() => {
            this.map.delete(key);
        });
        this.map.set(key, promise);
        return promise;
    }
}
