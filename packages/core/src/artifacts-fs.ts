import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactMeta, ArtifactStatus, ArtifactStore } from "@saddlebags/sdk";

/** Zero-config artifact library on the local filesystem. */
export class FsArtifactStore implements ArtifactStore {
  constructor(private root: string) {}

  async put(
    body: Uint8Array | string,
    meta: { operation: string; contentType: string; tags?: Record<string, string> },
  ): Promise<ArtifactMeta> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const id = createHash("sha256").update(bytes).digest("hex");
    const existing = await this.readMeta(id);
    if (existing) return existing;
    const m: ArtifactMeta = {
      id,
      operation: meta.operation,
      contentType: meta.contentType,
      tags: meta.tags ?? {},
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, `${id}.bin`), bytes);
    await this.writeMeta(m);
    return m;
  }

  async get(id: string) {
    const meta = await this.readMeta(id);
    if (!meta) return undefined;
    return { meta, body: new Uint8Array(await readFile(join(this.root, `${id}.bin`))) };
  }

  async list(filter: { operation?: string; status?: ArtifactStatus } = {}): Promise<ArtifactMeta[]> {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch {
      return [];
    }
    const metas = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => this.readMeta(f.slice(0, -5))),
    );
    return metas.filter(
      (m): m is ArtifactMeta =>
        !!m &&
        (!filter.operation || m.operation === filter.operation) &&
        (!filter.status || m.status === filter.status),
    );
  }

  async setStatus(id: string, status: ArtifactStatus): Promise<ArtifactMeta> {
    const m = await this.readMeta(id);
    if (!m) throw new Error(`No artifact ${id}`);
    const next = { ...m, status };
    await this.writeMeta(next);
    return next;
  }

  private async readMeta(id: string): Promise<ArtifactMeta | undefined> {
    try {
      return JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8")) as ArtifactMeta;
    } catch {
      return undefined;
    }
  }

  private writeMeta(m: ArtifactMeta) {
    return writeFile(join(this.root, `${m.id}.json`), JSON.stringify(m, null, 2));
  }
}
