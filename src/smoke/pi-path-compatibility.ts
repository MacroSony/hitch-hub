import path from "node:path";
import { assertInstalledPiPathCompatibility, assertPiPathResolversCompatible } from "../security/pi-path-compatibility.js";

async function main(): Promise<void> {
  const receipt = await assertInstalledPiPathCompatibility(
    process.env.HITCH_PI_COMMAND ?? "pi",
    path.resolve("runtime/credential-guard.mjs"),
  );
  let rejectedDrift = false;
  try {
    assertPiPathResolversCompatible(
      (input, cwd) => path.resolve(cwd, input),
      (input) => input.startsWith("@") ? input.slice(1) : input,
    );
  } catch {
    rejectedDrift = true;
  }
  if (!rejectedDrift) {
    throw new Error("Pi path compatibility attestation accepted a resolver with normalization drift.");
  }
  process.stdout.write(`Pi path compatibility smoke ok: version=${receipt.version}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
