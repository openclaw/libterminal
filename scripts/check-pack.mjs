import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "libterminal-pack-"));

try {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const [{ filename, files }] = JSON.parse(output);
  const expected = [
    "dist/browser.js",
    "dist/index.js",
    "dist/node.js",
    "dist/protocol.js",
    "dist/stream.js",
    "dist/testing.js",
    "dist/worker.js",
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

  const archive = join(process.cwd(), filename);
  writeFileSync(join(workdir, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", archive],
    { cwd: workdir, stdio: "pipe" },
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
        "@openclaw/libterminal/testing",
      ])}.map((specifier) => import(specifier)));`,
    ],
    { cwd: workdir, stdio: "pipe" },
  );

  rmSync(filename, { force: true });
} finally {
  rmSync(workdir, { force: true, recursive: true });
}
