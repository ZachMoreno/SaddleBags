import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { ArtifactMeta, ArtifactStatus, ArtifactStore } from "@saddlebags/sdk";

export interface S3ArtifactStoreOptions {
  bucket: string;
  /** Key prefix, e.g. "saddlebags/artifacts/". */
  prefix?: string;
  /** Any S3-compatible endpoint: AWS, Cloudflare R2, MinIO, Backblaze B2... */
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

/**
 * The artifact library on S3-compatible storage. Bodies are stored at
 * `<prefix><sha256>`, and metadata as JSON at `<prefix><sha256>.meta.json`.
 */
export class S3ArtifactStore implements ArtifactStore {
  private s3: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(opts: S3ArtifactStoreOptions) {
    this.s3 = opts.client ?? new S3Client(opts.clientConfig ?? {});
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "";
  }

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
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.prefix + id, Body: bytes, ContentType: m.contentType }),
    );
    await this.writeMeta(m);
    return m;
  }

  async get(id: string) {
    const meta = await this.readMeta(id);
    if (!meta) return undefined;
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + id }));
    return { meta, body: await obj.Body!.transformToByteArray() };
  }

  async list(filter: { operation?: string; status?: ArtifactStatus } = {}): Promise<ArtifactMeta[]> {
    const out: ArtifactMeta[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        if (!o.Key?.endsWith(".meta.json")) continue;
        const m = await this.readMeta(o.Key.slice(this.prefix.length, -".meta.json".length));
        if (m && (!filter.operation || m.operation === filter.operation) && (!filter.status || m.status === filter.status)) {
          out.push(m);
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async setStatus(id: string, status: ArtifactStatus): Promise<ArtifactMeta> {
    const m = await this.readMeta(id);
    if (!m) throw new Error(`No artifact ${id}`);
    const next = { ...m, status };
    await this.writeMeta(next);
    return next;
  }

  private async readMeta(id: string): Promise<ArtifactMeta | undefined> {
    const Key = `${this.prefix}${id}.meta.json`;
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
    } catch {
      return undefined;
    }
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key }));
    return JSON.parse(await obj.Body!.transformToString()) as ArtifactMeta;
  }

  private async writeMeta(m: ArtifactMeta) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}${m.id}.meta.json`,
        Body: JSON.stringify(m),
        ContentType: "application/json",
      }),
    );
  }
}
