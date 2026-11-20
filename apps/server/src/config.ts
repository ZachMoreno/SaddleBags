import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, ModelProvider, ScopeRef } from "@saddlebags/sdk";

export type StoreConfig =
  | { kind: "sqlite"; /** Relative to the config file. Default `.saddlebags/saddlebags.db`. */ path?: string }
  | { kind: "postgres"; url: string; /** Default `public`. */ schema?: string };

export interface SaddlebagsConfig {
  /** Plugin package names (resolved from the project's node_modules), or plugin objects. */
  plugins: Array<string | Plugin>;
  /** Default: SQLite at `.saddlebags/saddlebags.db`. */
  store?: StoreConfig;
  /** `"env"` (default) registers every provider whose API key is set. */
  providers?: "env" | ModelProvider[];
  /** Model that decides model-decided rule conditions, e.g. "anthropic:claude-opus-5-5". */
  selectorModel?: `${string}:${string}`;
  /** Minimum eval pass rate for promotion. Default 1. */
  minPassRate?: number;
  /**
   * The scope evals run as. Default `{ orgId: "eval" }`. Plugins with required
   * MCP servers need a scope that holds connections to them.
   */
  evalScope?: ScopeRef;
  mcp?: {
    /** Exact commands stdio MCP servers may run. Default none: stdio servers are refused. */
    stdioAllowlist?: string[];
    /** How long a server's tool list is reused, in ms. Default 60000. */
    toolListTtlMs?: number;
  };
  server?: { port?: number; host?: string };
}

export const defineConfig = (config: SaddlebagsConfig): SaddlebagsConfig => config;

export const CONFIG_FILES = ["saddlebags.config.ts", "saddlebags.config.mjs", "saddlebags.config.js"];

export interface LoadedConfig {
  config: SaddlebagsConfig;
  /** Directory holding the config file; plugins and relative paths resolve from here. */
  root: string;
}

/** Find and import the project's config, searching from `cwd` upward. */
export async function loadConfig(cwd = process.cwd(), explicit?: string): Promise<LoadedConfig> {
  const file = explicit ? resolve(cwd, explicit) : findConfig(cwd);
  if (!file) {
    throw new Error(`No ${CONFIG_FILES[0]} found in ${cwd} or its parents. Run \`saddlebags init\` to create one.`);
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: SaddlebagsConfig };
  if (!mod.default?.plugins) throw new Error(`${file} must default-export defineConfig({ plugins: [...] })`);
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
 * Import a plugin package as the project sees it: resolved from `root`'s
 * node_modules (not the server's), honoring the package's ESM `exports`.
 */
export async function importPlugin(name: string, root: string): Promise<Plugin> {
  const pkgDir = findPackageDir(name, root);
  if (!pkgDir) throw new Error(`Plugin package "${name}" is not installed in ${root}. Run \`saddlebags install ${name}\`.`);
  const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as {
    version: string;
    main?: string;
    exports?: unknown;
  };
  const entry = esmEntry(pkg) ?? "index.js";
  const mod = (await import(pathToFileURL(join(pkgDir, entry)).href)) as { default?: Plugin };
  const plugin = mod.default;
  if (!plugin?.routes) throw new Error(`"${name}" does not default-export a plugin (definePlugin({...}))`);
  return plugin;
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
