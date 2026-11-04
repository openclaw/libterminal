# Test cleanup ledger

Audit base: `422b447` (2026-11-03). Keep public-contract regressions; remove
redundant fixtures only when surviving tests exercise the same behavior.

| Surface                                    | Decision and evidence                                                                                                                                                                                                                                        | Status            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Hub close validation                       | Remove two `NativeCloseSocket` tests and the fake validator. `hub-close.test.ts` covers reserved codes and oversized reasons against a real WebSocket peer, including peer closure and error reporting. Keep injected-transport fallback tests.              | Passed            |
| Transport timing                           | Drive reconnect delay and cancellation with fake timers; replace two zero-delay waits with the existing event-loop helper; await bridge completion under the runner timeout instead of racing a 50 ms timer.                                                 | Passed            |
| Protocol, byte ownership, fanout, batching | Keep distinct wire-vector, mutation, buffering, cancellation, and reentrant-subscriber checks. Retain the 100,000-fragment regression; remove its redundant 20,000-fragment variant. Verify a fast subscriber survives slow-subscriber overflow.             | Reviewed          |
| Browser color queries and assets           | Keep stream-split, replay, parser recovery, byte identity, and response-isolation checks.                                                                                                                                                                    | Reviewed          |
| Browser smoke                              | Keep all ten real-browser cases: two asset routes, lifecycle/input checks, and three rendering workloads per route. They validate canvas changes and retained output; timing records are diagnostics. Worker assets run in a browser, not a deployed Worker. | Passed (10 cases) |
| Node adapters and package scripts          | Keep distinct stdio teardown regressions and package install/import checks. Add a native PTY input/output and exit test; existing driver tests use an injected fake.                                                                                         | Passed            |
| Exported testing helpers                   | Keep the published test doubles and clock; their tests protect byte ownership and deterministic scheduling, and they remain public exports.                                                                                                                  | Reviewed          |

Transport cleanup validation: `pnpm check` passed (166 tests); `pnpm test:browser`
passed (10 cases) on Crabbox AWS, Linux, Node 24.19.0. Production LOC delta: zero.
No release is part of this audit.

Transport cleanup: [#141](https://github.com/openclaw/libterminal/pull/141).

Native PTY validation: `pnpm check` passed (167 tests), including a real child
process, split UTF-8 input, output draining, and exit on Linux.

Native PTY coverage: [#142](https://github.com/openclaw/libterminal/pull/142).

Final audit: all eleven unit/integration files and the ten-case browser suite were
reviewed against their runtime paths. No orphan fixture or demonstrated broken
public feature was found. Keep native WebSocket peers and browser rendering
checks; injected transports and PTY drivers still cover distinct error paths.

Stream cleanup validation: `pnpm check` passed (166 tests) and
`pnpm test:browser` passed (10 cases) on Crabbox AWS, Linux, Node 24.19.0.
The slow-subscriber test now checks continued delivery and closure for its fast
peer. All three changes have zero production LOC delta.
