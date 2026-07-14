import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config/load.js";
import { Authenticator } from "./auth/auth.js";
import { Registry } from "./runtime/registry.js";
import { buildApp } from "./api/app.js";

const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const configPath = process.env.OPENAI_SPEECH_SERVER_CONFIG ?? join(configHome, "openai-speech-server", "config.yaml");
const config = await loadConfig(configPath); const authenticator = await Authenticator.create(config); const registry = new Registry(config);
const app = await buildApp(config, authenticator, registry); void registry.start().catch((error) => app.log.error(error, "One or more providers failed initial warmup and will be restarted"));
const separator = config.server.listen.lastIndexOf(":"); const host = config.server.listen.slice(0, separator); const port = Number(config.server.listen.slice(separator + 1));
await app.listen({ host, port });
let closing = false;
async function shutdown(signal: string) { if (closing) return; closing = true; app.log.info({ signal }, "Draining service"); const forced = setTimeout(() => process.exit(1), config.server.shutdown_grace_seconds * 1000); forced.unref(); await app.close(); clearTimeout(forced); }
process.on("SIGTERM", () => void shutdown("SIGTERM")); process.on("SIGINT", () => void shutdown("SIGINT"));
