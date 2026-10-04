/** Loopback-only integration fixture: real API and worker supervisor, deterministic CPU workers. */
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { testConfig } from "../tests/helpers.js";
import { buildApp } from "../src/api/app.js";
import { Authenticator, hashToken } from "../src/auth/auth.js";
import { Registry } from "../src/runtime/registry.js";

const config = await testConfig({ request_timeout_seconds: 15 }, 8);
const directory = config.server.temp_directory;
const token = randomBytes(24).toString("hex");
await writeFile(config.auth.tokens_file, JSON.stringify({ tokens: { test: hashToken(token) } }), { mode: 0o600 });
for (const model of config.models) model.provider_config.options.fixture_directory = directory;
const optionsPath = join(directory, "fixture-config.json"); const observationsPath = join(directory, "observations.jsonl");
let settings = { transcripts: [] as string[], asrDelayMs: 0, ttsDurationSeconds: 1, generation: 0 };
await writeFile(optionsPath, JSON.stringify(settings), { mode: 0o600 }); await writeFile(observationsPath, "", { mode: 0o600 });
const registry = new Registry(config); await registry.start();
const app = await buildApp(config, await Authenticator.create(config), registry); app.log.level = "silent";
const url = await app.listen({ host: "127.0.0.1", port: 0 });
const Control = z.strictObject({ transcripts: z.array(z.string()).max(100).optional(), asrDelayMs: z.number().min(0).max(60_000).optional(), ttsDurationSeconds: z.number().positive().max(60).optional(), reset: z.boolean().optional() });
const control = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('{"error":"unauthorized"}'); return; }
  try {
    if (request.url !== "/") { response.writeHead(404).end("{}"); return; }
    if (request.method === "GET") {
      const events = (await readFile(observationsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      response.end(JSON.stringify({ transcriptions: events.filter((event) => event.type === "transcription").map(({ type: _type, ...event }) => event), speech: events.filter((event) => event.type === "speech").map(({ type: _type, ...event }) => event), cancelled: { transcription: events.filter((event) => event.type === "cancelled" && event.task === "transcription").length, speech: events.filter((event) => event.type === "cancelled" && event.task === "speech").length } })); return;
    }
    if (request.method !== "POST") { response.writeHead(405).end("{}"); return; }
    let source = ""; for await (const chunk of request) { source += chunk.toString(); if (source.length > 1_048_576) throw new Error("Control request too large"); }
    const { reset, ...next } = Control.parse(JSON.parse(source));
    settings = { ...(reset ? { transcripts: [], asrDelayMs: 0, ttsDurationSeconds: 1 } : settings), ...next, generation: settings.generation + 1 };
    if (reset) await writeFile(observationsPath, "");
    await writeFile(`${optionsPath}.next`, JSON.stringify(settings), { mode: 0o600 }); await rename(`${optionsPath}.next`, optionsPath);
    response.end('{"ok":true}');
  } catch { response.writeHead(400).end('{"error":"invalid_control"}'); }
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlPort = (control.address() as { port: number }).port;
process.stdout.write(`${JSON.stringify({ type: "ready", url, port: Number(new URL(url).port), token, controlUrl: `http://127.0.0.1:${controlPort}` })}\n`);
let closing = false;
async function shutdown() { if (closing) return; closing = true; await app.close(); await new Promise<void>((resolve) => control.close(() => resolve())); await rm(directory, { recursive: true, force: true }); process.exit(0); }
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { try { if (JSON.parse(line).type === "shutdown") void shutdown(); } catch { /* Ignore malformed fixture control input. */ } });
input.on("close", () => void shutdown());
process.once("SIGTERM", () => void shutdown()); process.once("SIGINT", () => void shutdown());
