import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const target = process.argv[2] ?? "scholarscope-lite";
const sourceFile = path.join(
  rootDir,
  "scripts",
  "extension",
  target,
  `${target}.user.js`,
);
const outputFile = path.join(
  rootDir,
  "scripts",
  "extension",
  "dist",
  `${target}.user.min.js`,
);
const esbuildBin = path.join(
  rootDir,
  "node_modules",
  "esbuild",
  "bin",
  "esbuild",
);

await fs.mkdir(path.dirname(outputFile), { recursive: true });

const source = await fs.readFile(sourceFile, "utf8");
const headerMatch = source.match(
  /^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==\s*/m,
);

if (!headerMatch) {
  throw new Error("Userscript metadata block not found.");
}

execFileSync(
  process.execPath,
  [
    esbuildBin,
    sourceFile,
    "--outfile=" + outputFile,
    "--minify",
    "--legal-comments=none",
    "--target=es2020",
  ],
  { stdio: "inherit" },
);

const minified = await fs.readFile(outputFile, "utf8");
await fs.writeFile(
  outputFile,
  `${headerMatch[0].trimEnd().replace(/\r?\n/g, "\n")}\n\n${minified}`,
  "utf8",
);

console.log(`Built ${path.relative(rootDir, outputFile)}`);
