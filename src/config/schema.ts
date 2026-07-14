import { z } from "zod";

const ProviderConfig = z.strictObject({
  python: z.string().min(1),
  checkpoint: z.string().min(1).optional(),
  device: z.string().min(1).default("auto"),
  workers: z.number().int().min(1).max(16).default(1),
  command: z.string().min(1).optional(),
  cancel_grace_seconds: z.number().positive().default(300),
  warmup_timeout_seconds: z.number().positive().default(120),
  options: z.record(z.string(), z.json()).default({}),
});

const ExtensionDefinitions = z.record(
  z.string().regex(/^[a-z][a-z0-9._-]*$/),
  z.strictObject({ schema: z.record(z.string(), z.json()) }),
).default({});

const BaseModel = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  display_label: z.string().min(1).optional(),
  default: z.boolean().default(false),
  enabled: z.boolean().default(true),
  required: z.boolean().default(true),
  languages: z.array(z.string().min(1)).default([]),
  extensions: ExtensionDefinitions,
  provider_config: ProviderConfig,
});

const TranscriptionModel = BaseModel.extend({
  task: z.literal("transcription"),
  provider: z.string().min(1),
  input_formats: z.array(z.enum(["wav", "webm", "ogg", "mp4", "mp3"])).nonempty().default(["wav", "webm", "ogg", "mp4", "mp3"]),
  language_auto_detect: z.boolean().default(true),
  supports_prompt: z.boolean().default(false),
  max_duration_seconds: z.number().positive().optional(),
});

const SpeechModel = BaseModel.extend({
  task: z.literal("speech"),
  provider: z.string().min(1),
  default_voice: z.string().min(1),
  voices: z.array(z.string().min(1)).nonempty(),
  output_formats: z.array(z.enum(["pcm", "wav"])).nonempty(),
  speed: z.strictObject({ min: z.number().positive(), max: z.number().positive(), default: z.number().positive() }).default({ min: 0.5, max: 2, default: 1 }),
  sample_rate: z.literal(24000).default(24000),
  channels: z.literal(1).default(1),
  encoding: z.literal("pcm_s16le").default("pcm_s16le"),
  max_text_length: z.number().int().positive().default(4096),
});

export const ConfigSchema = z.strictObject({
  server: z.strictObject({
    listen: z.string().min(3),
    request_timeout_seconds: z.number().positive().default(180),
    stream_idle_timeout_seconds: z.number().positive().default(30),
    queue_max_depth: z.number().int().min(0).default(8),
    queue_wait_timeout_seconds: z.number().positive().default(30),
    max_upload_bytes: z.number().int().positive().default(52_428_800),
    temp_directory: z.string().min(1).default("/tmp/openai-speech-server"),
    ffmpeg: z.string().min(1).default("/usr/bin/ffmpeg"),
    prlimit: z.string().min(1).default("/usr/bin/prlimit"),
    ffmpeg_memory_bytes: z.number().int().positive().default(2_147_483_648),
    normalization_timeout_seconds: z.number().positive().default(60),
    shutdown_grace_seconds: z.number().positive().default(30),
    metrics_enabled: z.boolean().default(true),
  }),
  auth: z.strictObject({ tokens_file: z.string().min(1) }),
  models: z.array(z.discriminatedUnion("task", [TranscriptionModel, SpeechModel])).nonempty(),
  clients: z.array(z.strictObject({
    id: z.string().min(1),
    token_ref: z.string().min(1),
    allowed_models: z.array(z.string()).nonempty(),
    allowed_voices: z.record(z.string(), z.array(z.string()).nonempty()).optional(),
    max_concurrent_requests: z.number().int().positive().default(2),
  })).nonempty(),
}).superRefine((config, context) => {
  const modelIds = new Set<string>();
  const defaultTasks = new Set<string>();
  for (const model of config.models) {
    if (modelIds.has(model.id)) context.addIssue({ code: "custom", path: ["models"], message: `Duplicate model id: ${model.id}` });
    if (model.id === "default") context.addIssue({ code: "custom", path: ["models", model.id, "id"], message: "Model id 'default' is reserved for compatibility resolution" });
    modelIds.add(model.id);
    if (model.default) {
      if (defaultTasks.has(model.task)) context.addIssue({ code: "custom", path: ["models", model.id, "default"], message: `Only one default ${model.task} model may be configured` });
      defaultTasks.add(model.task);
    }
    if (model.task === "speech") {
      if (!model.voices.includes(model.default_voice)) context.addIssue({ code: "custom", path: ["models", model.id, "default_voice"], message: "default_voice must appear in voices" });
      if (model.speed.min > model.speed.default || model.speed.default > model.speed.max) context.addIssue({ code: "custom", path: ["models", model.id, "speed"], message: "speed default must be within range" });
    }
    const bundled = (model.task === "transcription" && model.provider === "parakeet") || (model.task === "speech" && model.provider === "kokoro");
    if (!bundled && !model.provider_config.command) context.addIssue({ code: "custom", path: ["models", model.id, "provider_config", "command"], message: `Provider '${model.provider}' requires an explicit worker command` });
  }
  const clientIds = new Set<string>();
  for (const client of config.clients) {
    if (clientIds.has(client.id)) context.addIssue({ code: "custom", path: ["clients"], message: `Duplicate client id: ${client.id}` });
    clientIds.add(client.id);
    for (const id of client.allowed_models) if (!modelIds.has(id)) context.addIssue({ code: "custom", path: ["clients", client.id], message: `Unknown allowed model: ${id}` });
    for (const [id, voices] of Object.entries(client.allowed_voices ?? {})) {
      const model = config.models.find((entry) => entry.id === id);
      if (!model || model.task !== "speech") {
        context.addIssue({ code: "custom", path: ["clients", client.id, "allowed_voices", id], message: `Voice allowlist model '${id}' is not a configured speech model` });
        continue;
      }
      if (!client.allowed_models.includes(id)) context.addIssue({ code: "custom", path: ["clients", client.id, "allowed_voices", id], message: `Voice allowlist model '${id}' is not in allowed_models` });
      for (const voice of voices) if (!model.voices.includes(voice)) context.addIssue({ code: "custom", path: ["clients", client.id, "allowed_voices", id], message: `Unknown voice '${voice}' for model '${id}'` });
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = Config["models"][number];
export type ModelExtensions = ModelConfig["extensions"];
export type SpeechModelConfig = Extract<ModelConfig, { task: "speech" }>;
export type TranscriptionModelConfig = Extract<ModelConfig, { task: "transcription" }>;
