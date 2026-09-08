import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { readGhosttyAsset } from "../dist/node.js";

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
const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>libterminal browser smoke</title>
    <script type="importmap">{"imports":{"ghostty-web":"/vendor/ghostty-web.js"}}</script>
    <style>
      html, body, #terminal { width: 800px; height: 320px; margin: 0; background: #111; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { createGhosttyTerminal } from "/dist/browser.js";
      try {
        const terminal = await createGhosttyTerminal({
          parent: document.querySelector("#terminal"),
          runtimeOptions: { wasmUrl: "/vendor/ghostty-vt.wasm" },
          size: { columns: 80, rows: 20 },
        });
        terminal.write(new TextEncoder().encode("\\u001b[32mLIBTERMINAL_SMOKE_OK\\u001b[0m"));
        window.smokeTerminal = terminal;
        document.body.dataset.ready = "true";
      } catch (error) {
        document.body.dataset.error = error?.stack ?? String(error);
      }
    </script>
  </body>
</html>`;

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
    if (pathname === "/") {
      send(response, html, "text/html; charset=utf-8");
      return;
    }
    const distFile = distScriptPath(pathname);
    if (distFile) {
      send(response, await readFile(distFile), "text/javascript; charset=utf-8");
      return;
    }
    const asset = await readGhosttyAsset(pathname);
    if (asset) {
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
