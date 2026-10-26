import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { ApiError } from "../src/api/errors.js";
import { ConfigSchema } from "../src/config/schema.js";
import { MAX_TEXT_BYTES, validateSpeechSubstitutionOutput } from "../src/substitutions/substitutions.js";
import { AsyncTextSubstitutions } from "../src/substitutions/runner.js";

const usage = "Usage: npm run preview:substitutions -- --config <config.yaml> [--task transcription|speech] [--client <client-id>] < sample.txt";

class PreviewError extends Error {}

async function readSample(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_TEXT_BYTES) throw new PreviewError(`Input exceeds ${MAX_TEXT_BYTES} UTF-8 bytes.`);
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    throw new PreviewError("Input must be valid UTF-8.");
  }
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({ options: { config: { type: "string" }, task: { type: "string", default: "transcription" }, client: { type: "string" }, help: { type: "boolean" } }, strict: true, allowPositionals: false }));
  } catch {
    throw new PreviewError(usage);
  }
  if (values.help) { process.stdout.write(`${usage}\n`); return; }
  if (!values.config || values.client === "" || (values.task !== "transcription" && values.task !== "speech")) throw new PreviewError(usage);
  const task = values.task;

  let source: string;
  try { source = await readFile(values.config, "utf8"); }
  catch { throw new PreviewError("Cannot read configuration file."); }
  let document: unknown;
  try { document = YAML.parse(source); }
  catch { throw new PreviewError("Configuration must be valid YAML."); }
  const parsed = ConfigSchema.safeParse(document);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map(issue => issue.path.join(".") || "configuration"))];
    throw new PreviewError(`Invalid configuration at: ${paths.join(", ")}.`);
  }
  const config = parsed.data;
  const client = values.client === undefined ? undefined : config.clients.find(entry => entry.id === values.client);
  if (values.client !== undefined && !client) throw new PreviewError("Unknown configured client ID.");
  const sample = await readSample();
  const substitutions = new AsyncTextSubstitutions(task === "speech" ? config.speech_substitutions : config.transcription_substitutions, task);
  try {
    await substitutions.start();
    const result = await substitutions.apply(sample, task === "speech" ? client?.speech_rule_set : client?.transcription_rule_set);
    if (task === "speech") validateSpeechSubstitutionOutput(sample, result.text);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await substitutions.stop();
  }
}

main().catch(error => {
  const message = error instanceof PreviewError ? error.message
    : error instanceof ApiError ? `${error.code}: ${error.message}`
    : "Unable to apply substitutions; check the rules and text limits.";
  process.stderr.write(`preview: ${message}\n`);
  process.stdin.destroy();
  process.exitCode = 1;
});
