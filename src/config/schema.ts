import { z } from "zod";
import { MAX_RULE_SETS, MAX_RULES_PER_SET, MAX_RULE_TEXT_LENGTH, MAX_TOTAL_PROGRAM_SIZE, inspectSubstitutionPattern, isWellFormedUnicode } from "../transcription/substitutions.js";

// Node clamps larger setTimeout delays to 1 ms; keep advertised deadlines enforceable.
export const MAXIMUM_REALTIME_TIMEOUT_SECONDS = 2_147_483;

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

const SubstitutionName = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const SubstitutionRule = z.strictObject({
  id: SubstitutionName,
  pattern: z.string().min(1).max(MAX_RULE_TEXT_LENGTH),
  replacement: z.string().max(MAX_RULE_TEXT_LENGTH).refine(isWellFormedUnicode, "Substitution replacements must contain well-formed Unicode"),
  case_insensitive: z.boolean().default(true),
});

const TranscriptionSubstitutions = z.strictObject({
  default_rule_set: SubstitutionName.nullable().default(null),
  rule_sets: z.record(SubstitutionName, z.array(SubstitutionRule).max(MAX_RULES_PER_SET)).default({}),
}).superRefine((config, context) => {
  if (Object.keys(config.rule_sets).length > MAX_RULE_SETS) {
    context.addIssue({ code: "custom", path: ["rule_sets"], message: `At most ${MAX_RULE_SETS} substitution rule sets may be configured` });
    return;
  }
  if (config.default_rule_set !== null && !Object.hasOwn(config.rule_sets, config.default_rule_set)) context.addIssue({ code: "custom", path: ["default_rule_set"], message: "Unknown default transcription substitution rule set" });
  let totalProgramSize = 0;
  for (const [name, rules] of Object.entries(config.rule_sets)) {
    if (rules.length > MAX_RULES_PER_SET) continue; // The array schema already reports this limit.
    const ids = new Set<string>();
    rules.forEach((rule, index) => {
      if (ids.has(rule.id)) context.addIssue({ code: "custom", path: ["rule_sets", name, index, "id"], message: "Duplicate substitution rule id" });
      ids.add(rule.id);
      if (totalProgramSize > MAX_TOTAL_PROGRAM_SIZE) return;
      const inspection = inspectSubstitutionPattern(rule.pattern, rule.case_insensitive);
      totalProgramSize += inspection.programSize;
      if (inspection.error) context.addIssue({ code: "custom", path: ["rule_sets", name, index, "pattern"], message: inspection.error });
    });
  }
  if (totalProgramSize > MAX_TOTAL_PROGRAM_SIZE) context.addIssue({ code: "custom", path: ["rule_sets"], message: `Substitution rule sets exceed the ${MAX_TOTAL_PROGRAM_SIZE}-instruction total compiled program limit` });
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
    realtime: z.strictObject({
      max_buffer_bytes: z.number().int().min(4800).max(52_428_800).default(5_760_000),
      max_message_bytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
      max_output_bytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
      idle_timeout_seconds: z.number().positive().max(MAXIMUM_REALTIME_TIMEOUT_SECONDS).default(60),
      max_session_seconds: z.number().positive().max(MAXIMUM_REALTIME_TIMEOUT_SECONDS).default(3600),
    }).default({ max_buffer_bytes: 5_760_000, max_message_bytes: 1_048_576, max_output_bytes: 1_048_576, idle_timeout_seconds: 60, max_session_seconds: 3600 }),
  }),
  auth: z.strictObject({ tokens_file: z.string().min(1) }),
  transcription_substitutions: TranscriptionSubstitutions.default({ default_rule_set: null, rule_sets: {} }),
  models: z.array(z.discriminatedUnion("task", [TranscriptionModel, SpeechModel])).nonempty(),
  clients: z.array(z.strictObject({
    id: z.string().min(1),
    token_ref: z.string().min(1),
    allowed_models: z.array(z.string()).nonempty(),
    allowed_voices: z.record(z.string(), z.array(z.string()).nonempty()).optional(),
    max_concurrent_requests: z.number().int().positive().default(2),
    transcription_rule_set: SubstitutionName.nullable().optional(),
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
    if (client.transcription_rule_set != null && !Object.hasOwn(config.transcription_substitutions.rule_sets, client.transcription_rule_set)) context.addIssue({ code: "custom", path: ["clients", client.id, "transcription_rule_set"], message: "Unknown client transcription substitution rule set" });
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
