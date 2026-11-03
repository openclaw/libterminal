/// <reference types="vite/client" />
import "@xterm/xterm/css/xterm.css";
import { attachTerminalStream } from "@openclaw/libterminal/stream";
import { Terminal } from "@xterm/xterm";

// Keep your existing transport: only its ordered output iterator is required.
export function mountXterm(parent: HTMLElement, output: AsyncIterable<Uint8Array>) {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  terminal.open(parent);
  const abort = new AbortController();
  const done = attachTerminalStream(terminal, output, abort.signal);
  return {
    terminal,
    done,
    dispose() {
      abort.abort();
      terminal.dispose();
    },
  };
}
