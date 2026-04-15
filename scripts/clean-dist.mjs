#!/usr/bin/env node
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const distPath = resolve(process.cwd(), "dist");
rmSync(distPath, { recursive: true, force: true });
console.error(`Removed ${distPath}`);
