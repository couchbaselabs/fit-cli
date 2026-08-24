/**
 * Unit tests for the CSV parser.
 *
 * Run on their own:
 *   node --import tsx --test src/fit/ingest/tests/csv.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, parseCsvWithHeader } from "../csv.js";

test("parses plain rows", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3\n"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("parses a quoted field with commas and escaped quotes (a JSON blob)", () => {
  const json = '{"DocumentExistsException":3,"x":"a,b"}';
  const escaped = '"' + json.replaceAll('"', '""') + '"';
  assert.deepEqual(parseCsv(`t,errors\n1,${escaped}\n`), [
    ["t", "errors"],
    ["1", json],
  ]);
});

test("parses a quoted field with a newline", () => {
  assert.deepEqual(parseCsv('a\n"line1\nline2"\n'), [["a"], ["line1\nline2"]]);
});

test("handles crlf line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("keeps an empty trailing field", () => {
  assert.deepEqual(parseCsv("a,b\n1,\n"), [
    ["a", "b"],
    ["1", ""],
  ]);
});

test("handles no trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("throws on an unterminated quote", () => {
  assert.throws(() => parseCsv('a\n"oops'), /Unterminated/);
});

test("parseCsvWithHeader returns data rows", () => {
  assert.deepEqual(parseCsvWithHeader("a,b\n1,2\n", ["a", "b"]), [["1", "2"]]);
});

test("parseCsvWithHeader throws on a wrong header", () => {
  assert.throws(() => parseCsvWithHeader("a,c\n1,2\n", ["a", "b"]), /Unexpected CSV header/);
});

test("parseCsvWithHeader throws on a row with the wrong field count", () => {
  assert.throws(() => parseCsvWithHeader("a,b\n1\n", ["a", "b"]), /fields/);
});

test("parseCsvWithHeader gives no rows for a header-only file", () => {
  assert.deepEqual(parseCsvWithHeader("a,b\n", ["a", "b"]), []);
});
