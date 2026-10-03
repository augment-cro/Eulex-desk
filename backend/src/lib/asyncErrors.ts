/**
 * Express 4 does not catch a rejected promise from an async route handler:
 * the request hangs until Cloud Run's 1200 s timeout (504) and only
 * `[unhandledRejection]` is logged. That is how a Content-Disposition header
 * with "č" left every download of such a file hanging for 20 minutes.
 *
 * Forward those rejections to `next(err)` so the global error handler in
 * index.ts answers 500 (with CORS headers) at once. Same approach as the
 * express-async-errors package; Express 5 does this natively.
 */
type Next = (err?: unknown) => void;
type Handler = (req: unknown, res: unknown, next: Next) => unknown;
interface LayerPrototype {
    handle_request(this: { handle: Handler }, req: unknown, res: unknown, next: Next): void;
}

// Express 4 internal (stable since 4.0); typed locally, no @types for it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Layer = require("express/lib/router/layer") as { prototype: LayerPrototype };

let installed = false;

export function installAsyncErrorForwarding(): void {
    if (installed) return;
    installed = true;
    Layer.prototype.handle_request = function handleRequest(req, res, next) {
        const fn = this.handle;
        // Four-argument functions are error middleware — Express skips them
        // for a request without an error, exactly as the original does.
        if (fn.length > 3) {
            next();
            return;
        }
        try {
            const ret = fn(req, res, next);
            if (ret && typeof (ret as PromiseLike<unknown>).then === "function") {
                (ret as PromiseLike<unknown>).then(undefined, (err: unknown) =>
                    next(err ?? new Error("Route handler rejected without a reason")),
                );
            }
        } catch (err) {
            next(err);
        }
    };
}
