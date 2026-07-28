// Prints the values of the named environment variables, one per line, so a
// test can assert that the parent's secrets never reached the child.
// Usage: node print-env.mjs VAR [VAR...]
for (const name of process.argv.slice(2)) {
  process.stdout.write(`${name}=${process.env[name] ?? "<unset>"}\n`);
}
process.stdout.write(`ENV_KEY_COUNT=${Object.keys(process.env).length}\n`);
