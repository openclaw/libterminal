## Summary

<!-- What changed and why?
Lead with the problem, task, or value for terminal consumers, then explain the
implementation. Keep the summary specific to this change.

In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."

Illustrative example:
Implementation-first: "Update the stream cancellation handler."
Reader-first: "Cancelled terminal streams can leave readers waiting. Propagate
cancellation to the reader so consumers can finish cleanup."
-->

## Compatibility And Security

<!-- Note protocol, export, runtime, ordering, cancellation, or security impact. -->

## Validation

<!-- List exact commands and manual checks run.
Lead with what validation demonstrated and any gaps, then give the commands or
logs that support it. Distinguish passed, failed, and unrun checks.

Illustrative example (only claim results you verified):
Command-first: "Ran pnpm test."
Outcome-first: "The cancellation regression test passes: the reader finishes
without dropping queued output. Verified with pnpm test. Browser and Worker
integration checks were not run."
-->

- [ ] Tests added or updated when behavior changed
- [ ] Browser, Node.js, and Worker impact considered
- [ ] `CHANGELOG.md` updated when user-visible or compatibility-relevant
- [ ] No credentials, private paths, private hosts, or sensitive logs included
