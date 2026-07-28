// Reads stdin to EOF and reports how much arrived. With stdio[0] = "ignore"
// the child gets /dev/null and sees an immediate EOF; with an inherited or
// open stdin it would block forever waiting for input nobody can supply.
let total = 0;
for await (const chunk of process.stdin) {
  total += chunk.length;
}
process.stdout.write(`STDIN-BYTES=${total}\n`);
