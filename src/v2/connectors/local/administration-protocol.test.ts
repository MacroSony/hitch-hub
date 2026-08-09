import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import { TEST_CLIENT_CERTIFICATE_PEM } from "../remote/test-certificates.js";
import {
  decodeLocalProtocolClientFrame,
  decodeLocalProtocolServerFrame,
} from "./protocol.js";

function request(command: unknown): unknown {
  return {
    protocol: "hitch.local",
    version: 1,
    frame: "request",
    requestId: "admin-request-1",
    command,
  };
}

test("local administration command codec accepts references, canonical path, role, and complete DER only", () => {
  const certificateDer = new X509Certificate(TEST_CLIENT_CERTIFICATE_PEM).raw;
  const commands = [
    {
      kind: "admin-create-principal",
      principalReference: "user-b",
      displayName: "User B",
      role: "member",
      workspaceReference: "workspace-b",
      workspaceRoot: "/srv/hitch/workspaces/user-b",
    },
    { kind: "admin-disable-principal", principalReference: "user-b" },
    {
      kind: "admin-bind-client-certificate",
      principalReference: "user-b",
      bindingReference: "user-b-cert-v1",
      certificateDer: {
        encoding: "base64",
        byteLength: certificateDer.byteLength,
        data: certificateDer.toString("base64"),
      },
    },
    {
      kind: "admin-revoke-client-certificate",
      bindingReference: "user-b-cert-v1",
    },
  ];
  for (const command of commands) {
    assert.equal(
      decodeLocalProtocolClientFrame(request(command)).command.kind,
      command.kind,
    );
  }

  for (const command of [
    { ...commands[0], workspaceRoot: "relative/user-b" },
    { ...commands[0], workspaceRoot: "/srv/hitch/../escape" },
    { ...commands[0], workspaceRoot: "/" },
    { ...commands[0], workspaceRoot: "/srv/hitch/user-b/" },
    { ...commands[0], workspaceRoot: "/srv/hitch\\user-b" },
    { ...commands[0], workspaceRoot: "/srv/hitch/\u0000user-b" },
    { ...commands[0], role: "owner" },
    {
      ...commands[2],
      certificateDer: {
        encoding: "base64",
        byteLength: certificateDer.byteLength + 1,
        data: certificateDer.toString("base64"),
      },
    },
  ]) {
    assert.throws(
      () => decodeLocalProtocolClientFrame(request(command)),
      CodecDecodeError,
    );
  }
});

test("local administration result codec covers principal and certificate lifecycle without content", () => {
  const results = [
    {
      kind: "principal-created",
      principalId: "principal-2",
      workspaceId: "workspace-2",
    },
    { kind: "principal-disabled", principalId: "principal-2" },
    { kind: "principal-already-disabled", principalId: "principal-2" },
    {
      kind: "client-certificate-bound",
      principalId: "principal-2",
      identityBindingId: "binding-2",
      fingerprint: `sha256:${"ab".repeat(32)}`,
    },
    {
      kind: "client-certificate-revoked",
      identityBindingId: "binding-2",
    },
    {
      kind: "client-certificate-already-revoked",
      identityBindingId: "binding-2",
    },
  ];
  for (const result of results) {
    const decoded = decodeLocalProtocolServerFrame({
      protocol: "hitch.local",
      version: 1,
      frame: "response",
      requestId: "admin-request-1",
      outcome: { status: "succeeded", result },
    });
    assert.equal(decoded.frame, "response");
    if (decoded.frame === "response" && decoded.outcome.status === "succeeded") {
      assert.equal(decoded.outcome.result.kind, result.kind);
    }
  }
});
