// Types of browser.mjs (for TypeScript plugins through @harness/plugin-sdk/runtime).
/** The Chromium to launch (HARNESS_CHROMIUM, else Playwright's), or undefined when there is none. */
export declare function chromiumPath(): string | undefined;
export declare function closeBrowser(): Promise<void>;
/** Runs fn with the shared headless browser (playwright-core's Browser). */
export declare function withBrowser<T>(fn: (browser: any) => Promise<T>): Promise<T>;
/** Serves a folder over HTTP on localhost; close() stops it. */
export declare function serveDir(root: string): Promise<{ origin: string; close(): Promise<void> }>;
/** Opens a page from a folder and drives it (actions: wait, press, click, type, eval, screenshot...). */
export declare function runPage(o: { root: string; file?: string; query?: string; viewport?: { width: number; height: number }; actions?: unknown[]; evaluate?: string; save?: string; screenshot?: boolean; fullPage?: boolean; paged?: unknown; waitMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<any>;
/** Frame-rate statistics of a running page. */
export declare function frameStats(ctx: unknown, png: unknown): Promise<any>;
export declare function describePage(r: unknown): string;
