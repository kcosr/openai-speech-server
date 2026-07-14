import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hashToken } from "../src/auth/auth.js";

const reference = process.argv[2];
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const path = process.argv[3] ?? join(configHome, "openai-speech-server", "tokens.json");
if (!reference) throw new Error("Usage: npx tsx scripts/create-token.ts <token-ref> [tokens-file]");
const token = randomBytes(32).toString("base64url"); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
let document: { tokens: Record<string, string> } = { tokens: {} };
try { document = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
document.tokens[reference] = hashToken(token); const temporary = `${path}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path);
process.stdout.write(`${token}\n`);
