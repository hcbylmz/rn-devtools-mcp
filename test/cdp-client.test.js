import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CDPClient } from "../src/cdp-client.js";
import { startMockMetro } from "./mock-metro.js";

let metro;
let client;

before(async () => {
  metro = await startMockMetro();
});

after(async () => {
  await metro.close();
});

beforeEach(() => {
  client = new CDPClient(metro.port);
});

test("connect succeeds and sends a 127.0.0.1 Origin", async () => {
  await client.connect();
  assert.equal(client.isConnected, true);
  assert.equal(metro.lastOrigin(), true, "backend should have accepted the Origin");
  client.disconnect();
});

test("send resolves with the matching response result", async () => {
  await client.connect();
  const res = await client.send("Runtime.evaluate", { expression: "1" });
  assert.equal(res.result.value, 1);
  client.disconnect();
});

test("send rejects with a timeout when no response arrives", async () => {
  await client.connect();
  await assert.rejects(
    () => client.send("Some.unanswered", {}, 200),
    /timed out/,
  );
  client.disconnect();
});

test("enableDomains tolerates the Unsupported fusebox handshake reply", async () => {
  await client.connect();
  await assert.doesNotReject(() => client.enableDomains());
  client.disconnect();
});

test("captures Runtime.exceptionThrown into exceptions[]", async () => {
  await client.connect();
  metro.emit({
    method: "Runtime.exceptionThrown",
    params: {
      timestamp: 123,
      exceptionDetails: {
        text: "Uncaught TypeError: boom",
        exception: { description: "TypeError: boom" },
        stackTrace: { callFrames: [{ functionName: "f", url: "bundle", lineNumber: 1, columnNumber: 2 }] },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.exceptions.length, 1);
  assert.match(client.exceptions[0].text, /boom/);
  client.disconnect();
});

test("captures network request lifecycle", async () => {
  await client.connect();
  metro.emit({
    method: "Network.requestWillBeSent",
    params: { requestId: "r1", request: { url: "https://api.test/x", method: "GET", headers: {} }, timestamp: 1, type: "Fetch" },
  });
  metro.emit({
    method: "Network.responseReceived",
    params: { requestId: "r1", response: { status: 200, statusText: "OK", headers: {}, mimeType: "application/json" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const req = client.networkRequests.get("r1");
  assert.equal(req.url, "https://api.test/x");
  assert.equal(req.status, 200);
  client.disconnect();
});

test("symbolicate maps frames via Metro /symbolicate", async () => {
  await client.connect();
  const frames = await client.symbolicate([
    { url: "http://localhost/index.bundle", lineNumber: 100, columnNumber: 4, functionName: "render" },
  ]);
  assert.equal(frames[0].file, "src/App.tsx");
  assert.equal(frames[0].lineNumber, 42);
  client.disconnect();
});

test("ensureConnected reconnects after a drop", async () => {
  await client.ensureConnected();
  assert.equal(client.isConnected, true);
  client.disconnect();
  assert.equal(client.isConnected, false);
  await client.ensureConnected();
  assert.equal(client.isConnected, true);
  client.disconnect();
});
