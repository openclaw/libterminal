# Test cleanup ledger

Audit base: `422b447` (2026-11-03). Keep public-contract regressions; remove
redundant fixtures only when surviving tests exercise the same behavior.

| Surface                                    | Decision and evidence                                                                                                                                                                                                                                        | Status            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Hub close validation                       | Remove two `NativeCloseSocket` tests and the fake validator. `hub-close.test.ts` covers reserved codes and oversized reasons against a real WebSocket peer, including peer closure and error reporting. Keep injected-transport fallback tests.              | Passed            |
| Transport timing                           | Drive reconnect delay and cancellation with fake timers; replace two zero-delay waits with the existing event-loop helper; await bridge completion under the runner timeout instead of racing a 50 ms timer.                                                 | Passed            |
| Protocol, byte ownership, fanout, batching | Keep distinct wire-vector, mutation, buffering, cancellation, and reentrant-subscriber checks. Large fragmented-buffer cases protect a previous trimming regression.                                                                                         | Reviewed          |
| Browser color queries and assets           | Keep stream-split, replay, parser recovery, byte identity, and response-isolation checks.                                                                                                                                                                    | Reviewed          |
| Browser smoke                              | Keep all ten real-browser cases: two asset routes, lifecycle/input checks, and three rendering workloads per route. They validate canvas changes and retained output; timing records are diagnostics. Worker assets run in a browser, not a deployed Worker. | Passed (10 cases) |
| Node adapters and package scripts          | Inspect remaining lifecycle fixtures, PTY behavior, and package boundaries.                                                                                                                                                                                  | Pending           |
| Exported testing helpers                   | Preserve published helpers until downstream usage and public-contract requirements are established.                                                                                                                                                          | Follow-up audit   |

Transport cleanup validation: `pnpm check` passed (166 tests); `pnpm test:browser`
passed (10 cases) on Crabbox AWS, Linux, Node 24.19.0. Production LOC delta: zero.
No release is part of this audit.
