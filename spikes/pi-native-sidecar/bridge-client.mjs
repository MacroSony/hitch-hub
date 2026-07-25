import net from "node:net";

const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function invokeBridge({
  socketPath,
  request,
  signal,
  cancelAfterEvent,
}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const events = [];
    let buffer = "";
    let settled = false;
    let cancellationSent = false;

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      fn(value);
    };

    const cancel = () => {
      if (cancellationSent || socket.destroyed) {
        return;
      }
      cancellationSent = true;
      socket.write(
        `${JSON.stringify({
          protocolVersion: 1,
          type: "cancel",
          requestId: request.requestId,
        })}\n`,
      );
    };

    signal?.addEventListener("abort", cancel, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      if (signal?.aborted) {
        cancel();
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        finish(reject, new Error("Sidecar response exceeded the line limit."));
        return;
      }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(reject, new Error("Sidecar emitted invalid JSON."));
          return;
        }
        if (message.requestId !== request.requestId) {
          continue;
        }
        if (message.type === "event") {
          events.push(message.event);
          if (cancelAfterEvent?.(message.event, events)) {
            cancel();
          }
          continue;
        }
        if (message.type === "complete") {
          finish(resolve, {
            events,
            result: message.result,
            observation: message.observation,
          });
          return;
        }
        if (message.type === "rejected") {
          const error = new Error(message.message);
          error.code = message.code;
          finish(reject, error);
          return;
        }
      }
    });
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => {
      if (!settled) {
        finish(reject, new Error("Sidecar closed before completing the request."));
      }
    });
  });
}

export function requestEnvelope({
  capability,
  turnId,
  connectionId,
  catalogDigest,
  providerId,
  modelId,
  requestId,
  context,
  options = {},
}) {
  return {
    protocolVersion: 1,
    type: "invoke",
    capability,
    requestId,
    turnId,
    connectionId,
    catalogDigest,
    providerId,
    modelId,
    context,
    options,
  };
}
