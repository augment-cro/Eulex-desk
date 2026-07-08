import "@testing-library/jest-dom/vitest";

// Node >= 22 ships a builtin `localStorage` global that is non-functional
// unless the process is started with `--localstorage-file`. It shadows
// jsdom's working implementation when vitest populates the test globals,
// so replace it with a simple in-memory Storage for tests.
class MemoryStorage {
    private map = new Map<string, string>();
    get length(): number {
        return this.map.size;
    }
    clear(): void {
        this.map.clear();
    }
    getItem(key: string): string | null {
        return this.map.has(key) ? (this.map.get(key) as string) : null;
    }
    key(index: number): string | null {
        return [...this.map.keys()][index] ?? null;
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
    setItem(key: string, value: string): void {
        this.map.set(key, String(value));
    }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, {
        value: new MemoryStorage(),
        writable: true,
        configurable: true,
    });
}
