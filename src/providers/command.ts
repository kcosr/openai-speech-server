import { fileURLToPath } from "node:url";
import type { ModelConfig } from "../config/schema.js";

export function resolveWorkerCommand(model: ModelConfig): string | undefined {
  if (model.provider_config.command) return model.provider_config.command;
  const bundled = model.provider === "kokoro" ? "../../workers/kokoro/worker.py" : model.provider === "parakeet" ? "../../workers/parakeet/worker.py" : undefined;
  return bundled ? fileURLToPath(new URL(bundled, import.meta.url)) : undefined;
}
