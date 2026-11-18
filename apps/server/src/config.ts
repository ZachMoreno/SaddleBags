import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Bag, ModelProvider } from "@saddlebags/sdk";

export type StoreConfig =
  | { kind: "sqlite"; /** Relative to the config file. Default `.saddlebags/saddlebags.db`. */ path?: string }
  | { kind: "postgres"; url: string; /** Default `public`. */ schema?: string };

export interface SaddlebagsConfig {
  /** Bag package names (resolved from the project's node_modules), or bag objects. */
  bags: Array<string | Bag>;
  /** Default: SQLite at `.saddlebags/saddlebags.db`. */
  store?: StoreConfig;
  /** `"env"` (default) registers every provider whose API key is set. */
  providers?: "env" | ModelProvider[];
  /** Model that decides model-decided rule conditions, e.g. "anthropic:claude-opus-5-5". */
  selectorModel?: `${string}:${string}`;
  /** Minimum eval pass rate for promotion. Default 1. */
  minPassRate?: number;
  server?: { port?: number; host?: string };
}

export const defineConfig = (config: SaddlebagsConfig): SaddlebagsConfig => config;

export const CONFIG_FILES = ["saddlebags.config.ts", "saddlebags.config.mjs", "saddlebags.config.js"];

export interface LoadedConfig {
  config: SaddlebagsConfig;
  /** Directory holding the config file; bags and relative paths resolve from here. */
  root: string;
}

/** Find and import the project's config, searching from `cwd` upward. */
export async function loadConfig(cwd = process.cwd(), explicit?: string): Promise<LoadedConfig> {
  const file = explicit ? resolve(cwd, explicit) : findConfig(cwd);
  if (!file) {
    throw new Error(`No ${CONFIG_FILES[0]} found in ${cwd} or its parents. Run \`saddlebags init\` to create one.`);
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: SaddlebagsConfig };
  if (!mod.default?.bags) throw new Error(`${file} must default-export defineConfig({ bags: [...] })`);
  return { config: mod.default, root: dirname(file) };
}

function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of CONFIG_FILES) {
      const f = join(dir, name);
      if (existsSync(f)) return f;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Import a bag package as the project sees it: resolved from `root`'s
 * node_modules (not the server's), honoring the package's ESM `exports`.
 */
export async function importBag(name: string, root: string): Promise<Bag> {
  const pkgDir = findPackageDir(name, root);
  if (!pkgDir) throw new Error(`Bag package "${name}" is not installed in ${root}. Run \`saddlebags install ${name}\`.`);
  const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as {
    version: string;
    main?: string;
    exports?: unknown;
  };
  const entry = esmEntry(pkg) ?? "index.js";
  const mod = (await import(pathToFileURL(join(pkgDir, entry)).href)) as { default?: Bag };
  const bag = mod.default;
  if (!bag?.routes) throw new Error(`"${name}" does not default-export a bag (defineBag({...}))`);
  return bag;
}

export function findPackageDir(name: string, root: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function esmEntry(pkg: { main?: string; exports?: unknown }): string | undefined {
  const e = pkg.exports;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const dot = (e as Record<string, unknown>)["."] ?? e;
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const d = dot as Record<string, unknown>;
      for (const k of ["import", "default", "node"]) if (typeof d[k] === "string") return d[k] as string;
    }
  }
  return pkg.main;
}
