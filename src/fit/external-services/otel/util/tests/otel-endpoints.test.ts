/**
 * Unit tests for otel-endpoints.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/fit/external-services/otel/util/tests/otel-endpoints.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { otelEndpoints } from "../otel-endpoints.js";

test("collector endpoints are performer-relative (host.docker.internal), plaintext, no trailing slash", () => {
  const endpoints = otelEndpoints();
  assert.equal(endpoints.collector.otlpGrpc, "http://host.docker.internal:4317");
  assert.equal(endpoints.collector.otlpHttp, "http://host.docker.internal:4318");
  assert.equal(endpoints.collector.otlpGrpc.startsWith("https://"), false);
  assert.equal(endpoints.collector.otlpGrpc.endsWith("/"), false);
});

test("jaeger endpoint is driver-relative (localhost) and scheme-less", () => {
  const endpoints = otelEndpoints();
  assert.equal(endpoints.jaeger.queryGrpc, "localhost:16685");
  assert.equal(/^[a-z]+:\/\//.test(endpoints.jaeger.queryGrpc), false);
});

test("prometheus baseUrl is driver-relative, plaintext, no trailing slash or path prefix", () => {
  const endpoints = otelEndpoints();
  assert.equal(endpoints.prometheus.baseUrl, "http://localhost:9090");
  assert.equal(endpoints.prometheus.baseUrl.endsWith("/"), false);
});
