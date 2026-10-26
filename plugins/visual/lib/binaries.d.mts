// Types of binaries.mjs (for TypeScript plugins through @harness/plugin-sdk/runtime).
/** The names a program is looked for under on the PATH. */
export declare const pathNames: (name: string) => string[];
/** Fixed install paths on Linux or macOS (for probes run inside another machine or container). */
export declare const installPlaces: (name: string, platform: NodeJS.Platform | string) => string[];
/** The program's path on this machine (PATH, then the usual install places), or undefined. */
export declare function findBinary(name: string, o?: { platform?: NodeJS.Platform | string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean; listDir?: (d: string) => string[] }): string | undefined;
/** What to tell the person when the program is missing (how to install it here). */
export declare function missingMessage(name: string, platform?: NodeJS.Platform | string): string;
