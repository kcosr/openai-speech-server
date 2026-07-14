import type { Config, ModelConfig, SpeechModelConfig, TranscriptionModelConfig } from "../config/schema.js";
import type { Client } from "../auth/auth.js";
import type { Provider, SpeechProvider, TranscriptionProvider } from "../providers/types.js";
import { PythonSpeechProvider, PythonTranscriptionProvider } from "../providers/python.js";
import { WorkerSupervisor } from "../providers/supervisor.js";
import { ModelQueue } from "./admission.js";
import { invalid } from "../api/errors.js";
import { ExtensionValidator } from "../extensions/validator.js";
import { resolveWorkerCommand } from "../providers/command.js";

export type ModelRuntime = { config: ModelConfig; provider: Provider; queue: ModelQueue; extensions: ExtensionValidator };

export class Registry {
  readonly models = new Map<string, ModelRuntime>();
  constructor(private readonly config: Config) {
    for (const model of config.models) {
      const extensions = new ExtensionValidator(model.id, model.extensions);
      if (!model.enabled) continue;
      const command = resolveWorkerCommand(model);
      if (!command) throw new Error(`Model '${model.id}' has no worker command`);
      const init = { model_id: model.id, task: model.task, provider: model.provider, device: model.provider_config.device, ...(model.provider_config.checkpoint ? { checkpoint: model.provider_config.checkpoint } : {}), options: model.provider_config.options };
      const supervisors = Array.from({ length: model.provider_config.workers }, () => new WorkerSupervisor(model.provider_config.python, [command], model.provider_config.cancel_grace_seconds * 1000, model.provider_config.warmup_timeout_seconds * 1000, init));
      const provider = model.task === "speech" ? new PythonSpeechProvider(supervisors) : new PythonTranscriptionProvider(supervisors);
      this.models.set(model.id, { config: model, provider, queue: new ModelQueue(model.provider_config.workers, config.server.queue_max_depth, config.server.queue_wait_timeout_seconds * 1000), extensions });
    }
  }
  async start() { await Promise.all([...this.models.values()].map(({ provider }) => provider.start())); }
  async stop() { await Promise.allSettled([...this.models.values()].map(({ provider }) => provider.stop())); }
  resolve(id: string, task: ModelConfig["task"], client: Client): ModelRuntime {
    const resolvedId = id === "default" ? this.defaultModelId(task, client) : id;
    const runtime = this.models.get(resolvedId);
    if (!runtime || runtime.config.task !== task || !client.allowed_models.includes(resolvedId)) throw invalid("model_not_found", `Model '${id}' is not available.`, "model");
    return runtime;
  }
  transcription(runtime: ModelRuntime) { return runtime.provider as TranscriptionProvider; }
  speech(runtime: ModelRuntime) { return runtime.provider as SpeechProvider; }
  resolveVoice(model: SpeechModelConfig, client: Client, requested: string | undefined): string {
    const allowed = allowedSpeechVoices(model, client);
    const effectiveDefault = allowed.includes(model.default_voice) ? model.default_voice : allowed[0];
    const voice = !requested || requested === "default" ? effectiveDefault : requested;
    if (!voice || !allowed.includes(voice)) throw invalid("unsupported_voice", `Voice '${requested ?? "default"}' is not supported by model '${model.id}'.`, "voice");
    return voice;
  }
  visible(client: Client) { return [...this.models.values()].filter(({ config }) => client.allowed_models.includes(config.id)); }
  capabilities(client: Client) {
    return { object: "list", data: this.visible(client).map(({ config: model, provider }) => model.task === "transcription" ? transcriptionCapability(model, provider, this.config.server.max_upload_bytes) : speechCapability(model, provider, client)) };
  }
  private defaultModelId(task: ModelConfig["task"], client: Client): string {
    const visible = this.visible(client).filter(({ config }) => config.task === task);
    const configured = visible.find(({ config }) => config.default);
    if (configured) return configured.config.id;
    if (visible.length === 1) return visible[0]!.config.id;
    throw invalid("model_not_found", `No default ${task} model is available.`, "model");
  }
}

function base(model: ModelConfig, provider: Provider) { return { id: model.id, task: model.task, display_label: model.display_label ?? model.id, default: model.default, ready: provider.ready, languages: model.languages, extensions: model.extensions }; }
function transcriptionCapability(model: TranscriptionModelConfig, provider: Provider, maxUploadBytes: number) { return { ...base(model, provider), input_formats: model.input_formats, language_auto_detect: model.language_auto_detect, max_upload_bytes: maxUploadBytes, max_duration_seconds: model.max_duration_seconds ?? null, supports_stream: true, supported_fields: ["file", "model", "language", "prompt", "response_format", "stream", "temperature", "extensions"] }; }
function speechCapability(model: SpeechModelConfig, provider: Provider, client: Client) {
  const voices = allowedSpeechVoices(model, client);
  const defaultVoice = voices.includes(model.default_voice) ? model.default_voice : voices[0];
  return { ...base(model, provider), voices: voices.map((id) => ({ id, display_label: id })), default_voice: defaultVoice, output_formats: model.output_formats.map((id) => ({ id, encoding: model.encoding })), speed: model.speed, audio: { sample_rate: model.sample_rate, channels: model.channels }, max_text_length: model.max_text_length, streams: true, supported_fields: ["model", "voice", "input", "response_format", "speed", "instructions", "stream_format", "extensions"] };
}

function allowedSpeechVoices(model: SpeechModelConfig, client: Client): string[] {
  const allowed = client.allowed_voices?.[model.id];
  return allowed ? model.voices.filter((voice) => allowed.includes(voice)) : model.voices;
}
