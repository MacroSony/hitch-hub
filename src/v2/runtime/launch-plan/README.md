# Pi 0.82 launch compatibility fixture

The V2-005 launch projection was manually reviewed on 2026-07-29 against the
cached published package `@earendil-works/pi-coding-agent@0.82.0`
(`sha256:a9c9d7f861a7508af5e516d493a03eac1fef36f8b56fb0d204da643950e5db08`
for the npm tarball).

The reviewed package establishes these fixed adapter facts:

- `dist/cli/args.js` parses `--no-extensions`, `--no-skills`,
  `--no-prompt-templates`, `--no-themes`, and `--no-context-files`;
- `dist/core/resource-loader.js` retains explicit CLI paths while those
  discovery switches suppress ambient defaults;
- `dist/cli/args.js` parses `--tools` as a comma-separated allowlist; and
- `dist/core/sdk.js` uses that supplied list as the complete initial active
  tool set.

The executable first slice therefore projects exactly
`--tools read,write,edit,ls`. It does not enable Pi's `bash` tool or any
extension/custom tool name.

These constants are a deterministic adapter compatibility fixture, not
production artifact verification. V2-006B still owns trusted artifact-root,
version, and digest verification before launch.
