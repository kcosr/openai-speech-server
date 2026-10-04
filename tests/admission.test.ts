import { describe, expect, it } from "vitest";
import { ClientAdmission, ModelQueue } from "../src/runtime/admission.js";
import { getEventListeners } from "node:events";
describe("admission", () => {
  it("enforces client concurrency", () => { const admission = new ClientAdmission(); const release = admission.acquire("a", 1); expect(() => admission.acquire("a", 1)).toThrow(/concurrency/); release(); expect(admission.acquire("a", 1)).toBeTypeOf("function"); });
  it("queues and releases in order", async () => { const queue = new ModelQueue(1, 1, 100); const first = await queue.acquire(new AbortController().signal); const second = queue.acquire(new AbortController().signal); expect(queue.depth).toBe(1); first(); const release = await second; release(); });
  it("rejects a full queue", async () => { const queue = new ModelQueue(1, 0, 100); await queue.acquire(new AbortController().signal); await expect(queue.acquire(new AbortController().signal)).rejects.toMatchObject({ code: "model_busy" }); });
  it("detaches abort listeners after queued work starts or is cancelled", async () => {
    const queue = new ModelQueue(1, 2, 1000); const controller = new AbortController(); const first = await queue.acquire(new AbortController().signal);
    const waiting = queue.acquire(controller.signal); expect(getEventListeners(controller.signal, "abort")).toHaveLength(1); first(); const release = await waiting;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const cancelled = queue.acquire(controller.signal); controller.abort(); await expect(cancelled).rejects.toBe(controller.signal.reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0); release(); expect(queue.occupancy).toBe(0);
  });
});
