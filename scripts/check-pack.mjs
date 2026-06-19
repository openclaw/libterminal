import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "libterminal-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmNeedsShell = process.platform === "win32";

try {
  const output = execFileSync(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", workdir],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: npmNeedsShell,
    },
  );
  /** @type {Array<{ filename: string; files: Array<{ path: string }> }>} */
  const pack = JSON.parse(output);
  const [{ filename, files }] = pack;
  const expected = [
    "dist/browser.d.ts",
    "dist/browser.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/node.d.ts",
    "dist/node.js",
    "dist/protocol.d.ts",
    "dist/protocol.js",
    "dist/stream.d.ts",
    "dist/stream.js",
    "dist/testing.d.ts",
    "dist/testing.js",
    "dist/worker.d.ts",
    "dist/worker.js",
    "dist/worker-assets.d.ts",
    "dist/worker-assets.js",
    "protocol/terminal-v2.json",
  ];
  const paths = new Set(files.map((file) => file.path));
  for (const path of expected) {
    if (!paths.has(path)) {
      throw new Error(`packed package is missing ${path}`);
    }
  }

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (pkg.name !== "@openclaw/libterminal") {
    throw new Error(`unexpected package name: ${pkg.name}`);
  }

  const archive = join(workdir, filename);
  writeFileSync(join(workdir, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", archive],
    { cwd: workdir, shell: npmNeedsShell, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify([
        "@openclaw/libterminal",
        "@openclaw/libterminal/protocol",
        "@openclaw/libterminal/stream",
        "@openclaw/libterminal/browser",
        "@openclaw/libterminal/node",
        "@openclaw/libterminal/worker",
        "@openclaw/libterminal/worker-assets",
        "@openclaw/libterminal/testing",
      ])}.map((specifier) => import(specifier)));`,
    ],
    { cwd: workdir, stdio: "pipe" },
  );
} finally {
  rmSync(workdir, { force: true, recursive: true });
}
