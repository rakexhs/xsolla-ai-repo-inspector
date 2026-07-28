// Spawns a long-lived grandchild, records both pids, then either hangs or
// exits. The grandchild is spawned *without* `detached`, so it inherits this
// process's group -- exactly what `npm test` -> test-runner looks like. Only a
// process-group kill reaches it; `child.kill()` on the direct child does not.
//
// Usage: node spawn-grandchild.mjs <pidFile> <hang|exit>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const mode = process.argv[3] ?? "hang";

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: "ignore",
});
// Let this process exit without waiting for the grandchild.
grandchild.unref();

writeFileSync(
  pidFile,
  JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
  "utf8",
);

if (mode === "exit") {
  process.exit(0);
} else {
  setInterval(() => {}, 1000);
}
