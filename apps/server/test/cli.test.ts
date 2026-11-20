import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { packageName, run, type CliDeps } from "../src/cli.js";

/** A project dir with a plain-JS plugin package in node_modules and a config. */
async function project(opts: { evalPasses?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sb-cli-"));
  const pkg = join(root, "node_modules", "@acme", "echo-plugin");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@acme/echo-plugin", version: "2.0.0", type: "module", exports: { ".": { import: "./index.js" } } }),
  );
  await writeFile(
    join(pkg, "index.js"),
    `export default {
      name: "@acme/echo-plugin",
      version: "2.0.0",
      routes: [{ operation: "echo", model: "mock:m" }],
      mcp: { servers: [{ name: "wiki", transport: { kind: "http", url: "http://wiki.invalid/mcp" }, auth: "token", connectAt: ["org", "user"], optional: true }] },
      memory: { policy: {}, seed: [{ scope: "org", key: "voice", value: "warm" }] },
      evals: [{ id: "e1", operation: "echo", input: "hi",
        graders: [{ kind: "code", name: "says-hi", assert: (o) => o === "hi" || "said " + o }] }],
    };`,
  );
  await writeFile(
    join(root, "saddlebags.config.mjs"),
    `export default {
      plugins: ["@acme/echo-plugin"],
      store: { kind: "sqlite", path: "db/sb.db" },
      providers: [{ id: "mock", generate: async (req) => ({ text: ${opts.evalPasses === false ? '"nope"' : '"hi"'}, model: req.model }) }],
    };`,
  );
  return root;
}

function cli(root: string, extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const execs: string[][] = [];
  const deps: Partial<CliDeps> = {
    cwd: root,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    env: {},
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
    },
    ...extra,
  };
  return {
    out,
    err,
    execs,
    run: (...args: string[]) => run(["node", "saddlebags", ...args], deps),
  };
}

describe("saddlebags CLI", () => {
  let root: string;
  beforeEach(async () => {
    root = await project();
  });

  it("installs, evaluates, promotes and unpublishes a plugin", async () => {
    const c = cli(root);
    expect(await c.run("install", "@acme/echo-plugin@2.0.0", "--org", "acme")).toBe(0);
    expect(c.execs).toEqual([["npm", "install", "@acme/echo-plugin@2.0.0"]]);
    expect(c.out.join("\n")).toMatch(/Installed @acme\/echo-plugin@2\.0\.0 as rc/);
    expect(c.out.join("\n")).toMatch(/Seeded starter memory/);

    expect(await c.run("promote", "@acme/echo-plugin")).toBe(1);
    expect(c.out.join("\n")).toMatch(/No eval run/);

    expect(await c.run("eval", "@acme/echo-plugin")).toBe(0);
    expect(c.out.join("\n")).toMatch(/100% passed/);

    expect(await c.run("promote", "@acme/echo-plugin")).toBe(0);
    c.out.length = 0;
    await c.run("status");
    expect(c.out[0]).toMatch(/@acme\/echo-plugin@2\.0\.0\s+latest\s+\[echo\]/);

    await c.run("unpublish", "@acme/echo-plugin", "2.0.0");
    c.out.length = 0;
    await c.run("status");
    expect(c.out[0]).toMatch(/unpublished/);
  });

  it("exits 1 when evals fail, and blocks promotion", async () => {
    root = await project({ evalPasses: false });
    const c = cli(root);
    await c.run("install", "@acme/echo-plugin", "--no-npm");
    expect(c.execs).toEqual([]);
    expect(await c.run("eval", "@acme/echo-plugin")).toBe(1);
    expect(c.out.join("\n")).toMatch(/says-hi: said nope/);
    expect(await c.run("promote", "@acme/echo-plugin")).toBe(1);
    expect(c.out.join("\n")).toMatch(/Pass rate 0% < 100%/);
  });

  it("lists and resolves memory proposals", async () => {
    const c = cli(root);
    await c.run("install", "@acme/echo-plugin", "--no-npm", "--org", "acme");
    // Seeds are trusted and approved immediately.
    await c.run("memory", "proposals", "--status", "approved");
    const line = c.out.find((l) => l.includes("voice"))!;
    expect(line).toMatch(/org:acme {2}voice = "warm" {2}\(seed\)/);

    const id = line.split(" ")[0]!;
    expect(await c.run("memory", "approve", id, "--reviewer", "dana")).toBe(1);
    expect(c.err.at(-1)).toMatch(/already approved/);
  });

  it("serves the API, binding localhost when no token is set", async () => {
    const listens: Array<[number, string]> = [];
    let fetch: ((r: Request) => Response | Promise<Response>) | undefined;
    const c = cli(root, {
      listen: async (f, port, host) => {
        fetch = f;
        listens.push([port, host]);
      },
    });
    expect(await c.run("serve", "--host", "0.0.0.0", "--port", "5000")).toBe(0);
    expect(listens).toEqual([[5000, "127.0.0.1"]]);
    expect(c.err.join("\n")).toMatch(/refusing to bind 0\.0\.0\.0/);
    const health = await (await fetch!(new Request("http://x/health"))).json();
    expect(health.plugins[0].name).toBe("@acme/echo-plugin");
  });

  it("creates a config with init, and won't overwrite one", async () => {
    const empty = await mkdtemp(join(tmpdir(), "sb-init-"));
    const c = cli(empty);
    await c.run("init");
    expect(await readFile(join(empty, "saddlebags.config.ts"), "utf8")).toMatch(/defineConfig/);
    await c.run("init");
    expect(c.out.at(-1)).toMatch(/already exists/);
  });

  it("explains a missing config", async () => {
    const empty = await mkdtemp(join(tmpdir(), "sb-none-"));
    const c = cli(empty);
    expect(await c.run("status")).toBe(1);
    expect(c.err.at(-1)).toMatch(/saddlebags init/);
  });
});

describe("saddlebags CLI: MCP connections and tokens", () => {
  it("connects with a credential from env or stdin, never printing it", async () => {
    const root = await project();
    const env = { SADDLEBAGS_SECRET_KEY: "d".repeat(64), WIKI_TOKEN: "wiki-secret" };
    const c = cli(root, { env, readStdin: async () => "stdin-secret\n" });

    expect(await c.run("mcp", "connect", "@acme/echo-plugin", "wiki", "--org", "acme", "--token-env", "WIKI_TOKEN")).toBe(0);
    expect(await c.run("mcp", "connect", "@acme/echo-plugin", "wiki", "--user", "dana", "--token-stdin")).toBe(0);
    expect(await c.run("mcp", "connect", "@acme/echo-plugin", "wiki", "--org", "a", "--user", "b", "--token-env", "WIKI_TOKEN")).toBe(1);
    expect(c.err.at(-1)).toMatch(/exactly one of --org, --group or --user/);
    expect(await c.run("mcp", "connect", "@acme/echo-plugin", "wiki", "--group", "g", "--token-env", "WIKI_TOKEN")).toBe(1);
    expect(c.err.at(-1)).toMatch(/org, user, not group/);

    c.out.length = 0;
    await c.run("mcp", "connections");
    expect(c.out).toHaveLength(2);
    expect(c.out.join("\n")).toMatch(/@acme\/echo-plugin:wiki {2}org:acme {2}credential/);
    expect(c.out.join("\n")).not.toMatch(/secret/);

    const id = c.out[0]!.split(" ")[0]!;
    expect(await c.run("mcp", "disconnect", id)).toBe(0);
    expect(await c.run("mcp", "disconnect", id)).toBe(1);

    // Without the key, credentials can't be stored.
    const noKey = cli(root, { env: { WIKI_TOKEN: "x" } });
    expect(await noKey.run("mcp", "connect", "@acme/echo-plugin", "wiki", "--org", "acme", "--token-env", "WIKI_TOKEN")).toBe(1);
    expect(noKey.err.at(-1)).toMatch(/SADDLEBAGS_SECRET_KEY/);
  });

  it("creates, lists and revokes scoped tokens", async () => {
    const c = cli(await project());
    expect(await c.run("token", "create", "--name", "claude-code", "--org", "acme", "--user", "dana")).toBe(0);
    const secret = c.out.at(-1)!;
    expect(secret).toMatch(/^sbt_[0-9a-f]{12}_/);
    const id = secret.split("_")[1]!;

    c.out.length = 0;
    await c.run("token", "list");
    expect(c.out[0]).toMatch(new RegExp(`${id} {2}claude-code {2}\\{"orgId":"acme","userId":"dana"\\} {2}active`));
    expect(c.out.join("\n")).not.toContain(secret);

    expect(await c.run("token", "revoke", id)).toBe(0);
    expect(await c.run("token", "revoke", id)).toBe(1);
    expect(await c.run("token", "create", "--name", "x")).toBe(1);
    expect(c.err.at(-1)).toMatch(/--org is required/);
  });
});

describe("packageName", () => {
  it("strips versions and tags, keeping scopes", () => {
    expect(packageName("@acme/plugin@1.2.3")).toBe("@acme/plugin");
    expect(packageName("@acme/plugin")).toBe("@acme/plugin");
    expect(packageName("plugin@rc")).toBe("plugin");
  });
});
