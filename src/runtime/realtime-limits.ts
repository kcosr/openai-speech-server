import { z } from "zod";
import type { Config, TranscriptionModelConfig } from "../config/schema.js";
import { REALTIME_BYTES_PER_SECOND } from "../media/pcm.js";

/** Public, effective limits for one authorized transcription model. */
export const RealtimeCapabilitySchema = z.strictObject({
  max_buffer_bytes: z.number().int().nonnegative().multipleOf(2),
  max_message_bytes: z.number().int().positive(),
  max_output_bytes: z.number().int().positive(),
  idle_timeout_seconds: z.number().positive(),
  max_session_seconds: z.number().positive(),
});
export type RealtimeCapability = z.infer<typeof RealtimeCapabilitySchema>;

/** The catalog and append admission share the same whole-sample PCM bound. */
export function effectiveRealtimeBufferBytes(settings: Config["server"]["realtime"], model: TranscriptionModelConfig): number {
  const durationBytes = model.max_duration_seconds === undefined ? Infinity : model.max_duration_seconds * REALTIME_BYTES_PER_SECOND;
  return Math.floor(Math.min(settings.max_buffer_bytes, durationBytes) / 2) * 2;
}

export function realtimeCapability(settings: Config["server"]["realtime"], model: TranscriptionModelConfig): RealtimeCapability {
  return RealtimeCapabilitySchema.parse({ ...settings, max_buffer_bytes: effectiveRealtimeBufferBytes(settings, model) });
}
