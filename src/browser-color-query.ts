export type TerminalDefaultColors = Readonly<{
  foreground: string;
  background: string;
  cursor: string;
}>;

export type TerminalDefaultColorQueryResponder = {
  /** Observes live terminal output and replies to complete default-color queries. */
  observe(data: string): void;
  /** Resets parser state from an authoritative replay without answering historical queries. */
  primeFromReplay(data: string): void;
};

export type TerminalDefaultColorQueryResponderOptions = {
  getColors: () => TerminalDefaultColors;
  reply: (data: string) => void;
};

type DynamicColorName = keyof TerminalDefaultColors;

const ESC = "\u001b";
const BEL = "\u0007";
const CAN = "\u0018";
const SUB = "\u001a";
const ST = `${ESC}\\`;
const MAX_PENDING_COLOR_SEQUENCE_CHARS = 1024;

const DYNAMIC_COLOR_SLOTS = [
  { color: "foreground", slot: 10 },
  { color: "background", slot: 11 },
  { color: "cursor", slot: 12 },
] as const satisfies ReadonlyArray<{ color: DynamicColorName; slot: number }>;
const DYNAMIC_COLOR_HEADERS = DYNAMIC_COLOR_SLOTS.map(({ slot }) => ({
  sequence: `${ESC}]${slot};`,
  slot,
}));

type OscTerminator = typeof BEL | typeof ST;
type OscBoundary =
  | { kind: "cancel"; index: number }
  | { kind: "restart"; index: number }
  | { kind: "terminator"; index: number; terminator: OscTerminator };

function findOscBoundary(data: string, start: number): OscBoundary | null {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === BEL) {
      return { kind: "terminator", index, terminator: BEL };
    }
    if (data[index] === CAN || data[index] === SUB) {
      return { kind: "cancel", index };
    }
    if (data[index] === ESC && data[index + 1] === "\\") {
      return { kind: "terminator", index, terminator: ST };
    }
    if (data[index] === ESC && data[index + 1] === "]") {
      return { kind: "restart", index };
    }
  }
  return null;
}

function formatOscColor(slot: number, color: string, terminator: OscTerminator): string | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  if (!match) {
    return null;
  }
  const [, red, green, blue] = match;
  return `${ESC}]${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}${terminator}`;
}

/**
 * Answers streamed OSC 10-12 dynamic-color queries for browser terminals whose
 * emulator does not emit those replies. Color values must use `#rrggbb` syntax.
 */
export function createTerminalDefaultColorQueryResponder(
  options: TerminalDefaultColorQueryResponderOptions,
): TerminalDefaultColorQueryResponder {
  let pending = "";
  let flushingReplies = false;
  const replies: string[] = [];

  const flushReplies = (): void => {
    if (flushingReplies) {
      return;
    }
    flushingReplies = true;
    let sent = 0;
    try {
      while (sent < replies.length) {
        options.reply(replies[sent]);
        sent += 1;
      }
    } finally {
      replies.splice(0, sent);
      flushingReplies = false;
    }
  };

  const process = (data: string, shouldReply: boolean): void => {
    pending += data;
    while (pending.length > 0) {
      const queryStart = pending.indexOf(`${ESC}]`);
      if (queryStart === -1) {
        pending = pending.endsWith(ESC) ? ESC : "";
        break;
      }
      if (queryStart > 0) {
        pending = pending.slice(queryStart);
      }

      const header = DYNAMIC_COLOR_HEADERS.find(({ sequence }) => pending.startsWith(sequence));
      if (!header) {
        if (DYNAMIC_COLOR_HEADERS.some(({ sequence }) => sequence.startsWith(pending))) {
          break;
        }
        pending = pending.slice(1);
        continue;
      }

      const boundary = findOscBoundary(pending, header.sequence.length);
      if (!boundary) {
        if (pending.length <= MAX_PENDING_COLOR_SEQUENCE_CHARS) {
          break;
        }
        pending = pending.slice(1);
        continue;
      }
      if (boundary.kind === "restart") {
        pending = pending.slice(boundary.index);
        continue;
      }
      if (boundary.kind === "cancel") {
        pending = pending.slice(boundary.index + 1);
        continue;
      }

      if (shouldReply) {
        const colors = options.getColors();
        let slot = header.slot;
        const payload = pending.slice(header.sequence.length, boundary.index);
        for (const value of payload.split(";")) {
          if (value) {
            const target = DYNAMIC_COLOR_SLOTS.find((entry) => entry.slot === slot);
            if (value === "?" && target) {
              const response = formatOscColor(slot, colors[target.color], boundary.terminator);
              if (response) {
                replies.push(response);
              }
            }
          }
          slot += 1;
        }
      }
      pending = pending.slice(boundary.index + boundary.terminator.length);
    }
    if (shouldReply) {
      flushReplies();
    }
  };

  return {
    observe(data: string): void {
      process(data, true);
    },
    primeFromReplay(data: string): void {
      pending = "";
      process(data, false);
    },
  };
}
