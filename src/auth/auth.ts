import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import { ApiError } from "../api/errors.js";

const TokensSchema = z.strictObject({ tokens: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/i)) });
export type Client = Config["clients"][number];

export class Authenticator {
  private constructor(private readonly entries: Array<{ client: Client; hash: Buffer }>) {}

  static async create(config: Config): Promise<Authenticator> {
    const data: unknown = JSON.parse(await readFile(config.auth.tokens_file, "utf8"));
    const tokens = TokensSchema.parse(data).tokens;
    return new Authenticator(config.clients.map((client) => {
      const hash = tokens[client.token_ref];
      if (!hash) throw new Error(`Missing token hash for reference '${client.token_ref}'`);
      return { client, hash: Buffer.from(hash, "hex") };
    }));
  }

  authenticate(header: string | undefined): Client {
    if (!header?.startsWith("Bearer ") || header.length === 7) throw new ApiError(401, "authentication_error", "invalid_token", "A valid bearer token is required.");
    const candidate = createHash("sha256").update(header.slice(7)).digest();
    let match: Client | undefined;
    for (const entry of this.entries) if (timingSafeEqual(candidate, entry.hash)) match = entry.client;
    if (!match) throw new ApiError(401, "authentication_error", "invalid_token", "A valid bearer token is required.");
    return match;
  }
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
