// Writes its own pid to the given file, then never exits.
// Usage: node sleep-forever.mjs [pidFile]
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile) writeFileSync(pidFile, String(process.pid), "utf8");
process.stdout.write("sleeping\n");
setInterval(() => {}, 1000);
