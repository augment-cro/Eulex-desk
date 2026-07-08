/**
 * Helpers for leaving the Office.js sandbox safely — URLs open in the user's
 * default browser instead of the narrow taskpane.
 */

export function getTaskpaneOrigin(): string {
    return typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://max.eulex.ai";
}

export function openInDefaultBrowser(url: string): void {
    try {
        const office = (
            globalThis as unknown as {
                Office?: {
                    context?: {
                        ui?: { openBrowserWindow?: (u: string) => void };
                    };
                };
            }
        ).Office;
        const opener = office?.context?.ui?.openBrowserWindow;
        if (typeof opener === "function") {
            opener(url);
            return;
        }
    } catch {
        /* fall through */
    }
    if (typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
    }
}
