// Prints a line to stdout and one to stderr, then exits with the given code.
// Usage: node exit-with.mjs <exitCode> [label]
const code = Number(process.argv[2] ?? "0");
const label = process.argv[3] ?? "fixture";
process.stdout.write(`${label}: stdout line\n`);
process.stderr.write(`${label}: stderr line\n`);
process.exit(code);
