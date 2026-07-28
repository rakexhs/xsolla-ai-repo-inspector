/**
 * Marks the compiled entry points executable.
 *
 * `tsc` preserves the `#!/usr/bin/env node` shebang but does not set the
 * executable bit. npm sets it at install time for `bin` targets, but running
 * `./dist/cli/main.js` straight out of a local build would otherwise fail with
 * EACCES — which is exactly the class of "the build passed but the binary is
 * broken" problem this project is meant to avoid.
 */
import { chmodSync, existsSync } from "node:fs";

const targets = ["dist/cli/main.js", "dist/mcp/server.js"];
let missing = false;

for (const target of targets) {
  if (!existsSync(target)) {
    console.error(`postbuild: expected build output missing: ${target}`);
    missing = true;
    continue;
  }
  chmodSync(target, 0o755);
}

if (missing) {
  console.error(
    "postbuild: the paths declared in package.json#bin were not produced by the build.",
  );
  process.exit(1);
}
