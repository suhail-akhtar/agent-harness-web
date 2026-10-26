// Types of libraries.mjs (for TypeScript plugins through @harness/plugin-sdk/runtime).
/** The browser and Node libraries the harness carries (three.js, ...). */
export declare const LIBRARIES: Record<string, { node?: boolean; install?: (root: string) => Promise<unknown>; [k: string]: unknown }>;
/** Copies a library into a folder (or adds a Node dependency): what was added and how to use it. */
export declare function addLibrary(root: string, name: string): Promise<{ version?: string; files: string; usage: string }>;
