import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStackString } from "../src/stack-parser.js";

test("returns [] for empty / non-string input", () => {
  assert.deepEqual(parseStackString(null), []);
  assert.deepEqual(parseStackString(""), []);
  assert.deepEqual(parseStackString(42), []);
});

test("parses Hermes 'fn@url:line:col' frames", () => {
  const stack =
    "Error: boom\n" +
    "boom@http://localhost:8081/index.bundle:12345:67\n" +
    "anonymous@http://localhost:8081/index.bundle:1:0";
  const frames = parseStackString(stack);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], {
    url: "http://localhost:8081/index.bundle",
    lineNumber: 12345,
    columnNumber: 67,
    functionName: "boom",
  });
});

test("parses V8 'at fn (url:line:col)' frames", () => {
  const stack =
    "Error: boom\n" +
    "    at render (http://localhost:8081/index.bundle:42:7)\n" +
    "    at http://localhost:8081/index.bundle:9:1";
  const frames = parseStackString(stack);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].functionName, "render");
  assert.equal(frames[0].lineNumber, 42);
  assert.equal(frames[0].columnNumber, 7);
  // anonymous frame still parsed for its location
  assert.equal(frames[1].functionName, "<anonymous>");
  assert.equal(frames[1].lineNumber, 9);
});

test("captures empty-url frames (eval'd / bytecode) for display", () => {
  const frames = parseStackString("Error: boom\n    at rnDevtoolsBoom (:1:54)");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].functionName, "rnDevtoolsBoom");
  assert.equal(frames[0].url, "");
  assert.equal(frames[0].lineNumber, 1);
  assert.equal(frames[0].columnNumber, 54);
});

test("skips lines without a location", () => {
  const frames = parseStackString("Error: just a message\nno location here");
  assert.deepEqual(frames, []);
});
