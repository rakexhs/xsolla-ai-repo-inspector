import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration, CLI and MCP tests spawn real processes and create real Git
    // repositories in a temp directory, so they need more than the default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites spawn real subprocesses and create real Git repositories, so
    // forks keep them isolated from each other and from the runner.
    pool: "forks",
    reporters: process.env["CI"] ? ["default", "junit"] : ["default"],
    outputFile: { junit: "reports/junit.xml" },
  },
});
