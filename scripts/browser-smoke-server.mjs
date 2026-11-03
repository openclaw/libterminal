import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { build } from "vite";
import { readGhosttyAsset } from "../dist/node.js";
import { readGhosttyWorkerAsset } from "../dist/worker-assets.js";

const host = "127.0.0.1";
const port = 4179;
const distRoot = path.resolve("dist");

/**
 * @param {string} pathname
 * @returns {string | null}
 */
function distScriptPath(pathname) {
  if (!pathname.startsWith("/dist/") || !pathname.endsWith(".js")) {
    return null;
  }
  const resolved = path.resolve(distRoot, pathname.slice("/dist/".length));
  if (resolved !== distRoot && !resolved.startsWith(`${distRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}
/** @param {"node" | "worker"} assets */
function html(assets) {
  const prefix = assets === "worker" ? "/worker" : "";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>libterminal browser smoke</title>
    <script type="importmap">{"imports":{"ghostty-web":"${prefix}/vendor/ghostty-web.js"}}</script>
    <style>
      html, body, #terminal { width: 800px; height: 320px; margin: 0; background: #111; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      try {
        const started = performance.now();
        const { createGhosttyTerminal, loadGhosttyRuntime } = await import("/dist/browser.js");
        const runtime = await loadGhosttyRuntime({ wasmUrl: "${prefix}/vendor/ghostty-vt.wasm" });
        window.smokeRuntimeMs = performance.now() - started;
        window.smokeInput = [];
        window.smokeResizes = [];
        const terminal = await createGhosttyTerminal({
          parent: document.querySelector("#terminal"),
          runtime,
          size: { columns: 80, rows: 20 },
          autoFit: false,
          terminalOptions: { scrollback: 100, cursorBlink: false },
          onData: (bytes) => window.smokeInput.push(new TextDecoder().decode(bytes)),
          onResize: (size) => window.smokeResizes.push(size),
        });
        window.smokeStartupMs = performance.now() - started;
        terminal.write(new TextEncoder().encode("\\u001b[32mLIBTERMINAL_SMOKE_OK\\u001b[0m"));
        window.smokeTerminal = terminal;
        document.body.dataset.ready = "true";
      } catch (error) {
        document.body.dataset.error = error?.stack ?? String(error);
      }
    </script>
  </body>
</html>`;
}

const xtermBuild = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    lib: { entry: "examples/xterm.ts", formats: ["es"], fileName: "xterm-example" },
    minify: true,
  },
});
const xtermOutputs = (Array.isArray(xtermBuild) ? xtermBuild : [xtermBuild]).flatMap((result) => {
  if (!("output" in result)) throw new Error("unexpected example build");
  return result.output;
});
const xtermScript = xtermOutputs.find((file) => file.type === "chunk");
if (!xtermScript || xtermScript.type !== "chunk") throw new Error("missing xterm example");

const xtermStyles = xtermOutputs
  .flatMap((file) =>
    file.type === "asset" && file.fileName.endsWith(".css") ? [String(file.source)] : [],
  )
  .join("\n");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;
    if (pathname === "/") {
      send(
        response,
        html(url.searchParams.get("assets") === "worker" ? "worker" : "node"),
        "text/html; charset=utf-8",
      );
      return;
    }
    if (pathname === "/xterm") {
      send(
        response,
        '<!doctype html><meta charset="utf-8"><title>xterm example</title><link rel="stylesheet" href="/xterm-example.css">',
        "text/html; charset=utf-8",
      );
      return;
    }
    if (pathname === "/xterm-example.css") {
      send(response, xtermStyles, "text/css; charset=utf-8");
      return;
    }
    if (pathname === "/xterm-example.js") {
      send(response, xtermScript.code, "text/javascript; charset=utf-8");
      return;
    }
    const distFile = distScriptPath(pathname);
    if (distFile) {
      send(response, await readFile(distFile), "text/javascript; charset=utf-8");
      return;
    }
    const fromWorker = pathname.startsWith("/worker/");
    const asset = fromWorker
      ? readGhosttyWorkerAsset(pathname.slice("/worker".length))
      : await readGhosttyAsset(pathname);
    if (asset) {
      response.setHeader("x-smoke-asset-source", fromWorker ? "worker" : "node");
      send(response, asset.body, asset.contentType);
      return;
    }
    response.writeHead(404).end("not found");
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : "server error");
  }
});

server.listen(port, host, () => {
  console.log(`browser smoke server listening on http://${host}:${port}`);
});

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string | Uint8Array} body
 * @param {string} contentType
 */
function send(response, body, contentType) {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
