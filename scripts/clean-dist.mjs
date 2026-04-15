#!/usr/bin/env node
import { existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const distPath = resolve(process.cwd(), "dist");
if (!existsSync(distPath)) {
  console.error(`No dist directory at ${distPath}`);
  process.exit(0);
}

const trashPath = resolve(
  dirname(distPath),
  `.dist-delete-${process.pid}-${Date.now()}`,
);

renameSync(distPath, trashPath);

const child = spawn(
  process.execPath,
  [
    "-e",
    "import('node:fs').then(({rmSync})=>rmSync(process.argv[1],{recursive:true,force:true}))",
    trashPath,
  ],
  {
    detached: true,
    stdio: "ignore",
  },
);
child.unref();

console.error(`Moved ${distPath} to ${trashPath}; deletion continues in background`);
