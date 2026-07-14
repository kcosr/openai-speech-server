import { readFile } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./schema.js";
import { resolveWorkerCommand } from "../providers/command.js";

export async function loadConfig(path: string): Promise<Config> {
  const source = await readFile(path, "utf8");
  const parsed: unknown = YAML.parse(source);
  const config = ConfigSchema.parse(parsed);
  const checks: Array<Promise<void>> = [
    assertExecutable("ffmpeg", config.server.ffmpeg),
    assertExecutable("prlimit", config.server.prlimit),
  ];
  for (const model of config.models.filter((entry) => entry.enabled)) {
    checks.push(assertExecutable(`Python executable for model '${model.id}'`, model.provider_config.python));
    const command = resolveWorkerCommand(model);
    if (!command) throw new Error(`Model '${model.id}' has no worker command`);
    checks.push(assertReadable(`Worker command for model '${model.id}'`, command));
  }
  await Promise.all(checks);
  return config;
}

async function assertExecutable(name: string, executable: string): Promise<void> {
  const candidates = executable.includes("/") ? [executable] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) try { await access(candidate, constants.X_OK); return; } catch { /* Try the next PATH entry. */ }
  throw new Error(`Configured ${name} is missing or not executable: ${executable}`);
}

async function assertReadable(name: string, path: string): Promise<void> {
  try { await access(path, constants.R_OK); } catch { throw new Error(`Configured ${name} is missing or not readable: ${path}`); }
}
