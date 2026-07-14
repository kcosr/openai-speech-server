import { Counter, Gauge, Histogram, Registry as PromRegistry, collectDefaultMetrics } from "prom-client";

export class Metrics {
  readonly registry = new PromRegistry();
  readonly requests = new Counter({ name: "openai_speech_server_requests_total", help: "Completed HTTP requests", labelNames: ["route", "status"], registers: [this.registry] });
  readonly duration = new Histogram({ name: "openai_speech_server_request_duration_seconds", help: "HTTP request duration", labelNames: ["route"], registers: [this.registry] });
  readonly queue = new Gauge({ name: "openai_speech_server_model_queue_depth", help: "Queued model requests", labelNames: ["model"], registers: [this.registry] });
  readonly workerRestarts = new Gauge({ name: "openai_speech_server_worker_restarts", help: "Worker restart count", labelNames: ["model"], registers: [this.registry] });
  readonly providerState = new Gauge({ name: "openai_speech_server_provider_state", help: "Provider state (1 for current state)", labelNames: ["model", "state"], registers: [this.registry] });
  constructor() { collectDefaultMetrics({ register: this.registry, prefix: "openai_speech_server_" }); }
}
