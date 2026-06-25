import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export function attachJsonlReader(stream: Readable, onJson: (value: unknown) => void, onError: (error: Error) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const consumeLine = (line: string): void => {
    if (line.length === 0) {
      return;
    }

    try {
      onJson(JSON.parse(line));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      consumeLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      consumeLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}
