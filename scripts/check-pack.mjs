import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "libterminal-pack-"));
const npmCommand = resolveNpmCli();

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} options
 */
function runNpm(args, options) {
  return execFileSync(process.execPath, [npmCommand, ...args], options);
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  if (process.platform !== "win32") {
    try {
      candidates.push(
        realpathSync(String(execFileSync("which", ["npm"], { encoding: "utf8" })).trim()),
      );
    } catch {
      // The standard bundled paths remain valid on supported non-Windows Node installations.
    }
  }
  const npmCli = candidates.find(
    (candidate) => candidate && basename(candidate) === "npm-cli.js" && existsSync(candidate),
  );
  if (!npmCli) {
    throw new Error("could not resolve npm-cli.js from the current Node installation");
  }
  return npmCli;
}

try {
  const output = String(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", workdir], {
      cwd: process.cwd(),
      encoding: "utf8",
    }),
  );
  /** @type {Array<{ filename: string; files: Array<{ path: string }> }> | Record<string, { filename: string; files: Array<{ path: string }> }>} */
  const pack = JSON.parse(output);
  const [{ filename, files }] = Array.isArray(pack) ? pack : Object.values(pack);
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
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", archive], {
    cwd: workdir,
    stdio: "pipe",
  });
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
