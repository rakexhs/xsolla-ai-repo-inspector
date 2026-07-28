// Emits ANSI colour codes and a carriage-return progress bar, which must be
// normalised away before the output is stored in a result.
const ESC = String.fromCharCode(27);
process.stdout.write(`${ESC}[31mRED-TEXT${ESC}[0m\n`);
process.stdout.write(`${ESC}[1;32mGREEN-BOLD${ESC}[0m\n`);
process.stderr.write(`${ESC}[33mYELLOW-ERR${ESC}[0m\n`);
