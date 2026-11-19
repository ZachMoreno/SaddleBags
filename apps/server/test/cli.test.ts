import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { packageName, run, type CliDeps } from "../src/cli.js";

/** A project dir with a plain-JS bag package in node_modules and a config. */
async function project(opts: { evalPasses?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sb-cli-"));
  const pkg = join(root, "node_modules", "@acme", "echo-bag");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@acme/echo-bag", version: "2.0.0", type: "module", exports: { ".": { import: "./index.js" } } }),
  );
  await writeFile(
    join(pkg, "index.js"),
    `export default {
      name: "@acme/echo-bag",
      version: "2.0.0",
      routes: [{ operation: "echo", model: "mock:m" }],
      memory: { policy: {}, seed: [{ scope: "org", key: "voice", value: "warm" }] },
      evals: [{ id: "e1", operation: "echo", input: "hi",
        graders: [{ kind: "code", name: "says-hi", assert: (o) => o === "hi" || "said " + o }] }],
    };`,
  );
  await writeFile(
    join(root, "saddlebags.config.mjs"),
    `export default {
      bags: ["@acme/echo-bag"],
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

  it("installs, evaluates, promotes and unpublishes a bag", async () => {
    const c = cli(root);
    expect(await c.run("install", "@acme/echo-bag@2.0.0", "--org", "acme")).toBe(0);
    expect(c.execs).toEqual([["npm", "install", "@acme/echo-bag@2.0.0"]]);
    expect(c.out.join("\n")).toMatch(/Installed @acme\/echo-bag@2\.0\.0 as rc/);
    expect(c.out.join("\n")).toMatch(/Seeded starter memory/);

    expect(await c.run("promote", "@acme/echo-bag")).toBe(1);
    expect(c.out.join("\n")).toMatch(/No eval run/);

    expect(await c.run("eval", "@acme/echo-bag")).toBe(0);
    expect(c.out.join("\n")).toMatch(/100% passed/);

    expect(await c.run("promote", "@acme/echo-bag")).toBe(0);
    c.out.length = 0;
    await c.run("status");
    expect(c.out[0]).toMatch(/@acme\/echo-bag@2\.0\.0\s+latest\s+\[echo\]/);

    await c.run("unpublish", "@acme/echo-bag", "2.0.0");
    c.out.length = 0;
    await c.run("status");
    expect(c.out[0]).toMatch(/unpublished/);
  });

  it("exits 1 when evals fail, and blocks promotion", async () => {
    root = await project({ evalPasses: false });
    const c = cli(root);
    await c.run("install", "@acme/echo-bag", "--no-npm");
    expect(c.execs).toEqual([]);
    expect(await c.run("eval", "@acme/echo-bag")).toBe(1);
    expect(c.out.join("\n")).toMatch(/says-hi: said nope/);
    expect(await c.run("promote", "@acme/echo-bag")).toBe(1);
    expect(c.out.join("\n")).toMatch(/Pass rate 0% < 100%/);
  });

  it("lists and resolves memory proposals", async () => {
    const c = cli(root);
    await c.run("install", "@acme/echo-bag", "--no-npm", "--org", "acme");
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
    expect(health.bags[0].name).toBe("@acme/echo-bag");
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

describe("packageName", () => {
  it("strips versions and tags, keeping scopes", () => {
    expect(packageName("@acme/bag@1.2.3")).toBe("@acme/bag");
    expect(packageName("@acme/bag")).toBe("@acme/bag");
    expect(packageName("bag@rc")).toBe("bag");
  });
});
