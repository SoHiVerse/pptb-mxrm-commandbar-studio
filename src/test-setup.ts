import "@testing-library/jest-dom";

// Node 26 exposes a separate process-global Web Storage getter. Give each test
// environment browser-like storage explicitly, rather than sharing a disk file.
const storage = new Map<string, string>();
const localStorageMock: Storage = {
	get length() { return storage.size; },
	clear() { storage.clear(); },
	getItem(key) { return storage.get(String(key)) ?? null; },
	key(index) { return [...storage.keys()][index] ?? null; },
	removeItem(key) { storage.delete(String(key)); },
	setItem(key, value) { storage.set(String(key), String(value)); },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorageMock });
