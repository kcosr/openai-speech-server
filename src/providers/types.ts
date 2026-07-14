export type ProviderExtensions = Readonly<Record<string, unknown>>;
export type TranscriptRequest = { path: string; language?: string; prompt?: string; extensions?: ProviderExtensions };
export type TranscriptResult = { text: string; language?: string };
export type SpeechRequest = { input: string; voice: string; speed: number; format: "pcm" | "wav"; extensions?: ProviderExtensions };

export interface Provider {
  readonly ready: boolean;
  readonly state: string;
  readonly restartCount: number;
  readonly inFlight: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface TranscriptionProvider extends Provider { transcribe(request: TranscriptRequest, signal: AbortSignal): Promise<TranscriptResult>; }
export interface SpeechProvider extends Provider { synthesize(request: SpeechRequest, signal: AbortSignal): AsyncIterable<Buffer>; }
