// Writes roughly 10 MB to stdout as fast as the pipe will take it.
// If the runner ever stops reading, this process blocks forever on write.
// Usage: node big-output.mjs [totalMegabytes]
const megabytes = Number(process.argv[2] ?? "10");
const chunk = `${"x".repeat(1023)}\n`; // 1 KiB including the newline
const perMegabyte = 1024;

for (let mb = 0; mb < megabytes; mb += 1) {
  for (let i = 0; i < perMegabyte; i += 1) {
    process.stdout.write(chunk);
  }
}
process.stdout.write("BIG-OUTPUT-DONE\n");
