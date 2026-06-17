# Contributing to @openclaw/libterminal

Thanks for helping improve the shared terminal primitives used across OpenClaw
projects.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## Before You Start

- Bugs and small fixes can go directly to a focused pull request.
- Discuss new protocol messages, breaking API changes, or large architectural
  changes in an issue before implementation.
- Search existing issues and pull requests before opening a duplicate.

## Development Setup

Use the Node.js and pnpm versions declared by the repository.

```bash
pnpm install
pnpm check
```

Use the smallest relevant command while iterating:

```bash
pnpm build
pnpm test
```

Do not replace pnpm, regenerate the lockfile with another package manager, or
edit generated output by hand.

## Pull Requests

- Keep one logical change per pull request.
- Use a conventional title such as `fix(stream): preserve cancellation reason`.
- Explain the problem, the chosen solution, and compatibility implications.
- Add or update tests for behavior changes.
- Cover affected browser, Node.js, and Worker paths when behavior is shared.
- Add an `Unreleased` changelog entry for user-visible, compatibility, security,
  or operational changes.
- Run `pnpm check` and report the exact validation performed.
- Resolve addressed review conversations before requesting another review.

Protocol definitions, exported types, event ordering, cancellation behavior, and
error shapes are public compatibility surfaces. Prefer additive changes and call
out any deliberate break explicitly.

For non-trivial changes, run the repository autoreview helper before handoff:

```bash
.agents/skills/autoreview/scripts/autoreview
```

## Reporting Bugs

Use the bug report template and include:

- the exact package version or commit
- the runtime and operating system
- a minimal reproduction
- expected and actual behavior
- relevant redacted logs or protocol messages

Never include credentials, private hostnames, personal paths, or sensitive
terminal output.

## Release Process

Maintainers publish from a `vX.Y.Z` tag on `main` through the trusted-publishing
workflow. Do not publish from a local machine or add an npm automation token.
