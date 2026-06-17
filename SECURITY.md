# Security Policy

If you believe you found a security issue in `@openclaw/libterminal`, report it
privately.

## Reporting

Open a private report through
[GitHub Security Advisories](https://github.com/openclaw/libterminal/security/advisories/new)
or email `security@openclaw.ai`.

Include:

1. affected version or commit
2. runtime and operating system
3. minimal reproduction
4. demonstrated impact
5. suggested remediation, if known

Do not open a public issue until maintainers have coordinated disclosure.

## Scope

Security issues in scope generally include:

- protocol parsing or framing flaws that cross a documented trust boundary
- terminal data leaking between sessions, streams, or consumers
- unsafe handling of terminal control data that produces concrete impact
- browser, Node.js, or Worker behavior differences that bypass a documented
  safety invariant
- dependency or release-pipeline compromise affecting the published package

Reports must demonstrate a concrete boundary bypass or impact. Prompt injection,
malicious terminal output, or hostile child-process behavior alone is not a
vulnerability unless the library promises and fails to enforce a relevant
boundary.

## Operational Guidance

- Keep `@openclaw/libterminal`, Node.js, and browser runtimes current.
- Treat terminal input and output as untrusted data.
- Do not log credentials or sensitive terminal contents.
- Pin and review dependency updates before publishing.

There is currently no paid bug bounty program.

