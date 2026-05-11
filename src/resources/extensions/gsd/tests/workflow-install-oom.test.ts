// gsd-2 — D004 reproduce-and-prevent test for workflow-install OOM (M003/S05/T01).
//
// Bug 1: `fetchWorkflowSource` previously called `await res.arrayBuffer()`
// before checking `MAX_RESPONSE_BYTES`, so a malicious server with a huge
// Content-Length (or a chunk-bombing body) could OOM the process. The fix
// is two-layer:
//   1) Reject up front when `Content-Length > MAX_RESPONSE_BYTES`
//      (never reads the body — getReader() must NOT be called).
//   2) Stream via `res.body.getReader()` and abort with `reader.cancel()`
//      when accumulated bytes exceed the cap.
//
// This test covers four sub-cases:
//   A) Content-Length pre-check rejects without consuming body.
//   B) Chunked stream guard aborts mid-stream and calls reader.cancel().
//   C) Positive control: a small body with valid Content-Length succeeds.
//   D) Seam round-trip: set/reset restores the real fetch path.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchWorkflowSource,
  _activeFetch,
  _setFetchForTests,
  _resetFetchForTests,
} from "../workflow-install.ts";

const MAX_BYTES = 256 * 1024;
const URL = "https://example.test/raw/workflow.yaml";

afterEach(() => {
  _resetFetchForTests();
});

describe("workflow-install OOM guard (M003/S05/T01 Bug 1)", () => {
  it("A: rejects oversized Content-Length BEFORE touching the body", async () => {
    let getReaderCalled = false;

    const fakeBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    // Wrap getReader() so we can prove it is NEVER invoked when the
    // Content-Length pre-check fires.
    const wrappedBody = new Proxy(fakeBody, {
      get(target, prop, receiver) {
        if (prop === "getReader") {
          return (...args: unknown[]) => {
            getReaderCalled = true;
            return (target.getReader as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const res = new Response(null, {
      status: 200,
      headers: { "content-length": "999999999" },
    });
    // Override the body getter to route through our spying proxy.
    Object.defineProperty(res, "body", {
      configurable: true,
      get: () => wrappedBody,
    });

    _setFetchForTests(async () => res);

    await assert.rejects(
      fetchWorkflowSource(URL),
      (err: Error) => {
        // Error must cite the declared (oversized) length and the cap.
        return /Response too large.*999999999.*262144/.test(err.message);
      },
      "Content-Length pre-check should reject before reading body",
    );

    assert.equal(
      getReaderCalled,
      false,
      "getReader() must NOT be called when Content-Length pre-check rejects",
    );
  });

  it("B: chunked-stream guard aborts mid-stream and calls reader.cancel()", async () => {
    let cancelCalled = false;
    let chunksEnqueued = 0;
    let pulledChunks = 0;

    // ~6 chunks of 64 KiB each = 384 KiB > 256 KiB cap. Stop enqueueing
    // once we've delivered enough to trip the guard so the test doesn't
    // wedge if cancel() is missed.
    const CHUNK_BYTES = 64 * 1024;
    const TOTAL_CHUNKS = 6;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksEnqueued >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK_BYTES));
        chunksEnqueued += 1;
      },
      cancel() {
        cancelCalled = true;
      },
    });

    // Spy on getReader so we can count actual reads (verifies streaming).
    const reader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      configurable: true,
      value: (...args: unknown[]) => {
        const r = (reader as (...a: unknown[]) => ReadableStreamDefaultReader<Uint8Array>)(
          ...args,
        );
        const realRead = r.read.bind(r);
        r.read = async () => {
          const result = await realRead();
          if (!result.done) pulledChunks += 1;
          return result;
        };
        return r;
      },
    });

    const res = new Response(body as ReadableStream, {
      status: 200,
      // No content-length header — forces Layer 2 to fire.
    });
    // Strip any auto-injected content-length.
    res.headers.delete("content-length");

    _setFetchForTests(async () => res);

    await assert.rejects(
      fetchWorkflowSource(URL),
      (err: Error) => /Response too large.*262144/.test(err.message),
      "Streamed body exceeding cap should throw",
    );

    assert.equal(cancelCalled, true, "reader.cancel() must be invoked when cap is exceeded");
    assert.ok(
      pulledChunks > 0 && pulledChunks <= TOTAL_CHUNKS,
      `Should have read at least one chunk before aborting (read ${pulledChunks})`,
    );
    // We must never have buffered all chunks — guard fires as soon as total > cap.
    // 256 KiB / 64 KiB = 4, so the 5th read trips it.
    assert.ok(
      pulledChunks <= 5,
      `Should abort by the 5th chunk at the latest (read ${pulledChunks})`,
    );
  });

  it("C: positive control — small body with valid Content-Length succeeds", async () => {
    const yamlBody = "name: small-test\nsteps: []\n";
    const bytes = new TextEncoder().encode(yamlBody);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const res = new Response(body as ReadableStream, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    });

    _setFetchForTests(async () => res);

    const fetched = await fetchWorkflowSource(URL);

    assert.equal(fetched.url, URL);
    assert.equal(fetched.ext, ".yaml");
    assert.equal(fetched.content, yamlBody);
    assert.match(fetched.sha256, /^[a-f0-9]{64}$/);
  });

  it("D: seam round-trip — set → call → reset restores the real fetch path", async () => {
    assert.equal(_activeFetch, null, "seam should start clean");

    const stub: typeof fetch = async () =>
      new Response("name: roundtrip\nsteps: []\n", {
        status: 200,
        headers: { "content-length": "26" },
      });
    _setFetchForTests(stub);
    assert.equal(_activeFetch, stub, "set should install the stub");

    const fetched = await fetchWorkflowSource(URL);
    assert.equal(fetched.ext, ".yaml");

    _resetFetchForTests();
    assert.equal(_activeFetch, null, "reset should clear the stub");
  });
});
