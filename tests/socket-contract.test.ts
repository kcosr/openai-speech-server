import { afterEach, describe, expect, it } from "vitest";
import net, { type AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/app.js";
import { Authenticator } from "../src/auth/auth.js";
import { Registry } from "../src/runtime/registry.js";
import { testConfig, TOKEN } from "./helpers.js";

describe("real socket streaming contract", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());
  async function boot(server = {}, concurrency = 2) { const config = await testConfig(server, concurrency); const registry = new Registry(config); await registry.start(); app = await buildApp(config, await Authenticator.create(config), registry); app.log.level = "silent"; await app.listen({ host: "127.0.0.1", port: 0 }); return { port: (app.server.address() as AddressInfo).port, registry }; }
  const speech = (port: number, input: string) => fetch(`http://127.0.0.1:${port}/v1/audio/speech`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "kokoro-local", voice: "af_heart", input, response_format: "pcm" }) });

  it("returns a JSON error before headers on first-byte timeout", async () => { const { port } = await boot({ request_timeout_seconds: 0.05 }); const response = await speech(port, "stall"); expect(response.status).toBe(504); expect((await response.json() as { error: { code: string } }).error.code).toBe("first_byte_timeout"); });
  it("aborts the transport on a mid-stream provider error", async () => { const { port } = await boot(); const response = await speech(port, "fail"); expect(response.status).toBe(200); await expect(response.arrayBuffer()).rejects.toThrow(); });
  it("recovers its replica reservation after worker process death", async () => { const { port, registry } = await boot(); const runtime = registry.models.get("kokoro-local")!; const response = await speech(port, "crash"); expect(response.status).toBe(200); await expect(response.arrayBuffer()).rejects.toThrow(); await expect.poll(() => runtime.provider.ready, { timeout: 3000 }).toBe(true); expect(runtime.provider.restartCount).toBeGreaterThan(0); expect(runtime.provider.inFlight).toBe(0); const followup = await speech(port, "hello"); expect(followup.status).toBe(200); });
  it("releases queue and client slots after a backpressured disconnect", async () => {
    const { port, registry } = await boot({ queue_wait_timeout_seconds: 0.2 }, 1); const socket = net.connect(port, "127.0.0.1"); await new Promise<void>((resolve) => socket.once("connect", resolve));
    const body = JSON.stringify({ model: "kokoro-local", voice: "af_heart", input: "large", response_format: "pcm" }); socket.write(`POST /v1/audio/speech HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.on("data", () => undefined); await new Promise((resolve) => setTimeout(resolve, 50)); socket.pause(); await new Promise((resolve) => setTimeout(resolve, 100)); socket.destroy();
    await expect.poll(() => registry.models.get("kokoro-local")?.queue.occupancy, { timeout: 2000 }).toBe(0); const followup = await speech(port, "hello"); expect(followup.status).toBe(200); expect((await followup.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
  it("times out a client that stops consuming backpressured audio", async () => {
    const { port, registry } = await boot({ stream_idle_timeout_seconds: 0.1 }, 2); const socket = net.connect(port, "127.0.0.1"); await new Promise<void>((resolve) => socket.once("connect", resolve));
    const body = JSON.stringify({ model: "kokoro-local", voice: "af_heart", input: "large", response_format: "pcm" }); socket.write(`POST /v1/audio/speech HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await expect.poll(() => registry.models.get("kokoro-local")?.queue.occupancy, { timeout: 1000 }).toBe(1); await expect.poll(() => registry.models.get("kokoro-local")?.queue.occupancy, { timeout: 3000 }).toBe(0); socket.destroy();
  });
});
