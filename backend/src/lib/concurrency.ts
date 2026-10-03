/**
 * Run `fn` over `items` with at most `limit` calls in flight. Rejects with
 * the first failure, like `Promise.all`: in-flight siblings run to
 * completion (their results are dropped) and no further item is started.
 * Callers that need results keyed by item collect them inside `fn`.
 */
export async function mapWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    if (items.length === 0) return;
    const width = Math.max(1, Math.min(Math.floor(limit), items.length));
    let next = 0;
    let failed = false;
    const workers = Array.from({ length: width }, async () => {
        while (!failed && next < items.length) {
            const item = items[next++];
            try {
                await fn(item);
            } catch (err) {
                failed = true;
                throw err;
            }
        }
    });
    await Promise.all(workers);
}
