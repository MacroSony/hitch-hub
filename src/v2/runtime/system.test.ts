import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeIsoTimestamp, decodeServiceId } from "../codecs/primitives.js";
import {
  CryptographicIdSource,
  SystemClock,
} from "./system.js";

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

test("production clock emits a canonical current UTC timestamp", () => {
  const before = Date.now();
  const timestamp = new SystemClock().now();
  const after = Date.now();

  assert.equal(decodeIsoTimestamp(timestamp), timestamp);
  assert.ok(Date.parse(timestamp) >= before);
  assert.ok(Date.parse(timestamp) <= after);
});

test("cryptographic ID source emits kind-bound safe service IDs", () => {
  const source = new CryptographicIdSource();
  const turnId = source.next("Turn");
  const sessionId = source.next("Session");

  assert.match(turnId, new RegExp(`^Turn:${UUID}$`, "u"));
  assert.match(sessionId, new RegExp(`^Session:${UUID}$`, "u"));
  assert.equal(decodeServiceId("Turn", turnId), turnId);
  assert.equal(decodeServiceId("Session", sessionId), sessionId);
  assert.notEqual(source.next("Turn"), turnId);
  assert.throws(
    () => source.next("not-a-kind" as never),
    /unknown service-allocated ID kind/u,
  );
});

test("cryptographic ID source emits independent opaque request correlations", () => {
  const source = new CryptographicIdSource();
  const idempotencyKey = source.nextTurnIdempotencyKey();
  const originMessageId = source.nextOriginMessageId();

  assert.match(idempotencyKey, /^ik:[A-Za-z0-9_-]{43}$/u);
  assert.match(originMessageId, new RegExp(`^om:${UUID}$`, "u"));
  assert.notEqual(source.nextTurnIdempotencyKey(), idempotencyKey);
  assert.notEqual(source.nextOriginMessageId(), originMessageId);
});
