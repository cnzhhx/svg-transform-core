import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CoreClientError,
  createSvgTransformClient,
} from "../dist/index.js";

const jsonResponse = (value, init) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

describe("createSvgTransformClient", () => {
  it('reconnects and resynchronizes CRLF/multiline SSE frames without reconnecting after close', async () => {
    let requests = 0;
    const encoder = new TextEncoder();
    const client = createSvgTransformClient({ baseUrl: 'https://core.example.test', fetch: async () => {
      requests++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"init",\r\ndata: "timestamp":${requests},"job":{}}\r\n\r\n`));
        controller.close();
      } }));
    } });
    const seen = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reconnect timed out')), 1000);
      const connection = client.connectJobEvents('job', { reconnectDelayMs: 1, onError: reject, onEvent(event) {
        seen.push(event.timestamp);
        if (seen.length === 2) { connection.close(); clearTimeout(timer); resolve(); }
      } });
    });
    assert.deepEqual(seen, [1, 2]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests, 2);
  });

  it('merges authorization headers and propagates cancellation as an abort', async () => {
    const client = createSvgTransformClient({ baseUrl: 'https://core.example.test', headers: { Authorization: 'Bearer example' }, fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer example');
      init.signal.throwIfAborted();
      return jsonResponse({ status: 'completed' });
    } });
    assert.equal((await client.getJob('job')).status, 'completed');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.getJob('job', { signal: controller.signal }), { name: 'AbortError' });
  });

  it('does not retry permanent SSE errors', async () => {
    let requests = 0;
    const client = createSvgTransformClient({ baseUrl: 'https://core.example.test', fetch: async () => {
      requests++;
      return jsonResponse({ error: 'missing' }, { status: 404 });
    } });
    await new Promise((resolve) => client.connectJobEvents('missing', { reconnectDelayMs: 1, onError: resolve }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests, 1);
  });
  it("normalizes the base URL and safely encodes job and file paths", async () => {
    const calls = [];
    const client = createSvgTransformClient({
      baseUrl: "https://core.example.test///",
      fetch: async (input, init) => {
        calls.push({ init, url: String(input) });
        return jsonResponse({ jobId: "job/one", status: "queued" });
      },
    });

    assert.equal(client.baseUrl, "https://core.example.test");
    assert.equal(
      client.jobPreviewUrl("job/one"),
      "https://core.example.test/api/jobs/job%2Fone/preview",
    );
    assert.equal(
      client.jobFileUrl("job/one", "/assets/logo mark#1.svg"),
      "https://core.example.test/api/jobs/job%2Fone/files/assets/logo%20mark%231.svg",
    );

    await client.startJob("job/one");
    assert.equal(
      calls[0].url,
      "https://core.example.test/api/jobs/job%2Fone/start",
    );
    assert.equal(calls[0].init.method, "POST");
  });

  it("creates the expected multipart upload without mutating binary input", async () => {
    const source = new Uint8Array([60, 115, 118, 103, 62]);
    let submittedForm;
    const client = createSvgTransformClient({
      baseUrl: "https://core.example.test",
      fetch: async (_input, init) => {
        submittedForm = init.body;
        return jsonResponse({ jobId: "job-1" });
      },
    });

    await client.createJob(
      { file: source, filename: "source.svg", type: "image/svg+xml" },
      { dryRun: true, model: "main", outputFormat: "flutter", scale: 2 },
    );

    assert.ok(submittedForm instanceof FormData);
    const file = submittedForm.get("svg");
    assert.ok(file instanceof Blob);
    assert.equal(file.name, "source.svg");
    assert.equal(file.type, "image/svg+xml");
    assert.equal(await file.text(), "<svg>");
    assert.equal(submittedForm.get("dryRun"), "true");
    assert.equal(submittedForm.get("model"), "main");
    assert.equal(submittedForm.get("outputFormat"), "flutter");
    assert.equal(submittedForm.get("scale"), "2");
    assert.deepEqual(source, new Uint8Array([60, 115, 118, 103, 62]));
  });

  it("preserves HTTP error details and wraps network failures", async () => {
    const rejectedClient = createSvgTransformClient({
      baseUrl: "https://core.example.test",
      fetch: async () =>
        jsonResponse(
          { error: "job not found", requestId: "request-1" },
          { status: 404, statusText: "Not Found" },
        ),
    });

    await assert.rejects(rejectedClient.getJob("missing"), (error) => {
      assert.ok(error instanceof CoreClientError);
      assert.equal(error.message, "job not found");
      assert.equal(error.status, 404);
      assert.deepEqual(error.payload, {
        error: "job not found",
        requestId: "request-1",
      });
      return true;
    });

    const offlineClient = createSvgTransformClient({
      baseUrl: "https://core.example.test",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });

    await assert.rejects(offlineClient.health(), (error) => {
      assert.ok(error instanceof CoreClientError);
      assert.equal(error.status, 502);
      assert.match(error.message, /connection refused/);
      return true;
    });
  });

  it("decodes server-sent events split across response chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"init","timestamp":1'));
        controller.enqueue(encoder.encode(',"job":{"jobId":"job-1"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"job:updated","jobId":"job-1"}\n\n'));
        controller.close();
      },
    });
    const client = createSvgTransformClient({
      baseUrl: "https://core.example.test",
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const events = [];
    let opened = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for SSE events")),
        1_000,
      );
      client.connectJobEvents("job-1", {
        onError: reject,
        onEvent: (event) => {
          events.push(event);
          if (events.length === 2) {
            clearTimeout(timeout);
            resolve();
          }
        },
        onOpen: () => {
          opened = true;
        },
      });
    });

    assert.equal(opened, true);
    assert.deepEqual(
      events.map(({ type }) => type),
      ["init", "job:updated"],
    );
  });
});
