/**
 * `apiRequest` throws the raw response body as the Error message, so it
 * must never be rendered. This predicate detects the backend's
 * validation/budget shape (`{ errors: [...] }`, HTTP 400) so callers can
 * pick a more specific translated message.
 */
export function isValidationErrorBody(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    try {
        const parsed: unknown = JSON.parse(err.message);
        return (
            typeof parsed === "object" &&
            parsed !== null &&
            Array.isArray((parsed as { errors?: unknown }).errors)
        );
    } catch {
        return false;
    }
}
