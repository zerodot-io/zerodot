// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Redis } from "ioredis";
import { createRunWaiter } from "./run-wake";

/** A subscriber that takes messages by hand. */
function fakeSubscriber() {
  const emitter = new EventEmitter() as EventEmitter & { subscribe: () => Promise<number> };
  emitter.subscribe = async () => 1;
  const send = (runId: string) => emitter.emit("message", "zerodot:run-wake", runId);
  return { subscriber: emitter as unknown as Redis, send };
}

describe("run waiter", () => {
  it("wakes the waiter of the run", async () => {
    const { subscriber, send } = fakeSubscriber();
    const wake = createRunWaiter(subscriber).arm("r1");
    const started = Date.now();
    setTimeout(() => send("r1"), 20);
    await wake.wait(5_000);
    wake.disarm();
    assert.ok(Date.now() - started < 1_000);
  });

  it("keeps a wake that comes before the wait", async () => {
    const { subscriber, send } = fakeSubscriber();
    const wake = createRunWaiter(subscriber).arm("r1");
    send("r1");
    const started = Date.now();
    await wake.wait(5_000);
    wake.disarm();
    assert.ok(Date.now() - started < 1_000);
  });

  it("ignores the wake of another run", async () => {
    const { subscriber, send } = fakeSubscriber();
    const wake = createRunWaiter(subscriber).arm("r1");
    send("r2");
    const started = Date.now();
    await wake.wait(60);
    wake.disarm();
    assert.ok(Date.now() - started >= 50);
  });

  it("ends the wait on abort", async () => {
    const { subscriber } = fakeSubscriber();
    const controller = new AbortController();
    const wake = createRunWaiter(subscriber).arm("r1", controller.signal);
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await wake.wait(5_000);
    wake.disarm();
    assert.ok(Date.now() - started < 1_000);
  });
});
