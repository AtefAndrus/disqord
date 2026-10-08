import { describe, expect, test } from "bun:test";
import { createInFlightTracker } from "../../../src/utils/inFlight";

describe("in-flight tracker", () => {
  test("drain waits for every tracked promise and resolves zero", async () => {
    const tracker = createInFlightTracker();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    tracker.track(first.promise);
    tracker.track(second.promise);
    let finished = false;
    const draining = tracker.drain(1_000).then((count) => {
      finished = true;
      return count;
    });
    first.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    second.resolve();
    expect(await draining).toBe(0);
    expect(await tracker.drain(0)).toBe(0);
  });

  test("timeout returns only the promises still unsettled", async () => {
    const tracker = createInFlightTracker();
    const pending = Promise.withResolvers<void>();
    tracker.track(Promise.resolve());
    tracker.track(pending.promise);
    tracker.track(new Promise(() => {}));
    expect(await tracker.drain(10)).toBe(2);
    pending.resolve();
    expect(await tracker.drain(10)).toBe(1);
  });

  test("rejections settle tracked work without rejecting drain or becoming unhandled", async () => {
    const tracker = createInFlightTracker();
    const failed = Promise.withResolvers<void>();
    tracker.track(failed.promise);
    const draining = tracker.drain(1_000);
    failed.reject(new Error("failed work"));
    expect(await draining).toBe(0);
    await Bun.sleep(0);
  });
});
