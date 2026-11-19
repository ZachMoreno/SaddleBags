#!/usr/bin/env node
// node:sqlite (the default store) is stable in practice but still flagged
// experimental in Node 22; hide that one warning so CLI output stays clean.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (message?.startsWith("SQLite is an experimental feature")) return;
  return emitWarning.call(process, warning, ...rest);
};

const { run } = await import("../dist/cli.js");
run(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
