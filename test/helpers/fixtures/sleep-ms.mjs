// Sleeps for the given number of milliseconds, then exits 0.
// Usage: node sleep-ms.mjs <milliseconds>
const ms = Number(process.argv[2] ?? "100");
setTimeout(() => {
  process.stdout.write(`SLEPT=${ms}\n`);
}, ms);
