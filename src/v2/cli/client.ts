import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import {
  LocalProtocolCorrelationGuard,
  decodeLocalProtocolServerJsonlFrame,
  encodeLocalProtocolClientJsonlFrame,
} from "../connectors/local/framing.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  LOCAL_PROTOCOL_NAME,
  LOCAL_PROTOCOL_VERSION,
  decodeLocalProtocolClientFrame,
  type LocalProtocolCommand,
  type LocalProtocolServerFrame,
} from "../connectors/local/protocol.js";
import {
  LOCAL_PROTOCOL_RUN_DIRECTORY,
  LOCAL_PROTOCOL_SOCKET_FILENAME,
} from "../connectors/local/socket.js";
import type { WalkingSkeletonStartupConfiguration } from "./configuration.js";

const MAXIMUM_SERVER_FRAMES = 1_024;
const CLIENT_REQUEST_TIMEOUT_MS = 30_000;

export class WalkingSkeletonClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WalkingSkeletonClientError";
  }
}

export function readBoundedCliImage(path: string): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY |
        (process.platform === "linux" ? constants.O_NOFOLLOW : 0),
    );
  } catch (error) {
    throw new WalkingSkeletonClientError(
      "unable to open the CLI image source",
      { cause: error },
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > LOCAL_PROTOCOL_LIMITS.maximumImageBytes
    ) {
      throw new WalkingSkeletonClientError(
        "CLI image must be a non-empty regular file within the image byte limit",
      );
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read === 0) {
        throw new WalkingSkeletonClientError(
          "CLI image changed or ended while being read",
        );
      }
      offset += read;
    }
    if (fstatSync(descriptor).size !== stat.size) {
      throw new WalkingSkeletonClientError(
        "CLI image changed while being read",
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function localSocketPath(
  configuration: WalkingSkeletonStartupConfiguration,
): string {
  return join(
    configuration.dataRoot,
    LOCAL_PROTOCOL_RUN_DIRECTORY,
    LOCAL_PROTOCOL_SOCKET_FILENAME,
  );
}

export async function executeLocalProtocolCommand(
  configuration: WalkingSkeletonStartupConfiguration,
  command: LocalProtocolCommand,
): Promise<readonly LocalProtocolServerFrame[]> {
  const request = decodeLocalProtocolClientFrame({
    protocol: LOCAL_PROTOCOL_NAME,
    version: LOCAL_PROTOCOL_VERSION,
    frame: "request",
    requestId: `request:${randomUUID()}`,
    command,
  });
  const bytes = encodeLocalProtocolClientJsonlFrame(request);
  const correlation = new LocalProtocolCorrelationGuard();
  correlation.acceptClient(request);
  const frames: LocalProtocolServerFrame[] = [];

  return await new Promise((resolve, reject) => {
    const socket = createConnection(localSocketPath(configuration));
    let pending = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new WalkingSkeletonClientError("local CLI request timed out"));
    }, CLIENT_REQUEST_TIMEOUT_MS);
    timer.unref();

    const finish = (): void => {
      if (settled) return;
      if (pending.length !== 0 || !correlation.isComplete) {
        fail(
          new WalkingSkeletonClientError(
            "local service closed before a complete protocol exchange",
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(Object.freeze([...frames]));
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => socket.write(Buffer.from(bytes)));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        if (newline + 1 > LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
          fail(new WalkingSkeletonClientError("server frame exceeds its byte limit"));
          return;
        }
        const line = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        let frame: LocalProtocolServerFrame;
        try {
          frame = decodeLocalProtocolServerJsonlFrame(line);
          correlation.acceptServer(frame);
        } catch (error) {
          fail(
            new WalkingSkeletonClientError(
              "local service returned an invalid protocol frame",
              { cause: error },
            ),
          );
          return;
        }
        frames.push(frame);
        if (frames.length > MAXIMUM_SERVER_FRAMES) {
          fail(new WalkingSkeletonClientError("server response stream is unbounded"));
          return;
        }
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
        fail(new WalkingSkeletonClientError("server frame exceeds its byte limit"));
      }
    });
    socket.once("end", finish);
    socket.once("close", () => {
      if (!settled) finish();
    });
    socket.once("error", (error) => {
      fail(
        new WalkingSkeletonClientError(
          "unable to communicate with the local v2 service",
          { cause: error },
        ),
      );
    });
  });
}
