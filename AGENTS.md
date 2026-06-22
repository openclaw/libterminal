# AGENTS.md - @openclaw/libterminal

## Purpose

`@openclaw/libterminal` provides shared TypeScript terminal protocol, streaming,
browser, Node.js, and Worker primitives.

Keep this repository small, portable, and explicit. Terminal protocol and stream
behavior are public compatibility surfaces, not implementation details.

## Repository

- GitHub: `https://github.com/openclaw/libterminal`
- npm: `https://www.npmjs.com/package/@openclaw/libterminal`
- Default branch: `main`
- Runtime: Node.js `>=22.13.0`
- Package manager: `pnpm`; use the version declared by the repository
- Human contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)

Read the nearest scoped `AGENTS.md` before changing files below this directory.
`CLAUDE.md` is a compatibility symlink to this file; edit `AGENTS.md` only.

## Architecture Boundaries

- Treat exported types, protocol messages, event ordering, error shapes, and
  cancellation behavior as public API.
- Keep protocol definitions runtime-neutral.
- Keep browser and Worker entry points free of Node.js built-ins and Node-only
  transitive imports.
- Keep Node.js process and stream integration out of browser and Worker paths.
- Preserve backpressure, ordering, teardown, and cancellation semantics across
  runtime adapters.
- Prefer additive protocol changes. Breaking protocol or export changes require
  explicit maintainer approval and a changelog entry.
- Do not add compatibility aliases or fallback behavior without a named shipped
  contract and a removal plan.

## Workflow

Install dependencies:

```bash
pnpm install
```

Use repository scripts instead of invoking underlying tools directly:

```bash
pnpm build
pnpm test
pnpm check
pnpm run check:release
```

Run the smallest relevant test while iterating. Run `pnpm check` before handoff
for code, protocol, test, package, or workflow changes.

## Change Rules

- Keep changes focused. Do not mix unrelated cleanup into a feature or fix.
- Update tests for behavior changes and regression fixes.
- Update `CHANGELOG.md` under `Unreleased` for user-visible, compatibility,
  security, or operational changes.
- Keep cross-runtime behavior covered when a change can affect more than one
  runtime.
- Do not edit generated output or dependency lockfiles by hand.
- Never commit credentials, private paths, private hosts, or unredacted logs.
- Use conventional commit and pull request titles such as `fix(protocol): ...`.

## Review And Release

- For non-trivial changes, run
  `.agents/skills/autoreview/scripts/autoreview` before final handoff.
- Verify every accepted review finding against the actual code and tests.
- Releases are tag-driven from `main` through `.github/workflows/release.yml`.
- Never publish locally or add long-lived npm tokens to repository settings.
