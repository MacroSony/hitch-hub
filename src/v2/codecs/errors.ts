export type CodecPathSegment = string | number;
export type CodecPath = readonly CodecPathSegment[];

export type CodecErrorCode =
  | "dangerous-key"
  | "duplicate-item"
  | "forbidden-path"
  | "forbidden-secret"
  | "invalid-format"
  | "invalid-type"
  | "non-finite-number"
  | "non-json-value"
  | "non-plain-object"
  | "out-of-range"
  | "too-long"
  | "too-many-items"
  | "unknown-field"
  | "unsupported-discriminant";

export interface CodecIssue {
  readonly path: CodecPath;
  readonly code: CodecErrorCode;
  readonly message: string;
}

export function formatCodecPath(path: CodecPath): string {
  return path.reduce<string>(
    (formatted, segment) =>
      typeof segment === "number"
        ? `${formatted}[${segment}]`
        : `${formatted}.${segment}`,
    "$",
  );
}

export class CodecDecodeError extends TypeError {
  readonly issues: readonly CodecIssue[];

  constructor(issue: CodecIssue | readonly CodecIssue[]) {
    const issues = Array.isArray(issue) ? issue : [issue];
    const first = issues[0]!;
    super(`${first.code} at ${formatCodecPath(first.path)}: ${first.message}`);
    this.name = "CodecDecodeError";
    this.issues = issues;
  }
}

export function codecFail(
  path: CodecPath,
  code: CodecErrorCode,
  message: string,
): never {
  throw new CodecDecodeError({ path: [...path], code, message });
}
