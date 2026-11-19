import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiToken, Store } from "@saddlebags/core";
import type { ScopeRef } from "@saddlebags/sdk";

const PREFIX = "sbt_";

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Bearer tokens for the /mcp endpoint, each bound to an org/group/user scope.
 * Format: `sbt_<id>_<secret>`. Only a hash of the secret is stored, so a token
 * is shown once, at creation.
 */
export class ApiTokens {
  constructor(private store: Store) {}

  async create(opts: { name: string; scope: ScopeRef; by: string }): Promise<{ token: string; record: ApiToken }> {
    const id = randomBytes(6).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    const record = await this.store.putApiToken({ id, name: opts.name, scope: opts.scope, secretHash: hash(secret) });
    await this.store.audit({ actor: opts.by, action: "token.create", subject: id, detail: { name: opts.name, scope: opts.scope } });
    return { token: `${PREFIX}${id}_${secret}`, record };
  }

  /** The token's record if the bearer value is valid and not revoked. */
  async verify(bearer: string | undefined): Promise<ApiToken | undefined> {
    if (!bearer?.startsWith(PREFIX)) return undefined;
    const rest = bearer.slice(PREFIX.length);
    const sep = rest.indexOf("_");
    if (sep <= 0) return undefined;
    const record = await this.store.getApiToken(rest.slice(0, sep));
    if (!record || record.revokedAt) return undefined;
    const got = Buffer.from(hash(rest.slice(sep + 1)), "hex");
    const want = Buffer.from(record.secretHash, "hex");
    return got.length === want.length && timingSafeEqual(got, want) ? record : undefined;
  }

  async revoke(id: string, by: string): Promise<boolean> {
    const ok = await this.store.revokeApiToken(id);
    if (ok) await this.store.audit({ actor: by, action: "token.revoke", subject: id });
    return ok;
  }

  list(): Promise<ApiToken[]> {
    return this.store.listApiTokens();
  }
}
