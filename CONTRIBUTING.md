# Contributing to Ownward

Thanks for helping make AI-assisted work more durable and user-controlled.

## Where changes belong

Before opening a feature PR, decide whether it belongs in the public base, a
Connector, an external Vertical, or a private company/personal repository.
The full boundary and extension checklist is in
[docs/contributing/extension-contract.md](docs/contributing/extension-contract.md).

As a rule of thumb, the public base accepts generic Kernel contracts and
reusable UI/data mechanisms. Company systems, private MCPs, contacts, raw
corpora, and domain-specific mappings stay in a private Vertical or Connector.
If a feature needs a capability that the current Kernel does not expose, submit
the generic Core Contract first; do not create a side channel from the Vertical.

## Before starting

- Open an Issue before a large feature or architecture change.
- Keep changes focused and avoid committing generated runtime data.
- Read [the development guide](docs/development.md) before changing the daemon,
  server, vault paths, approvals, or agent session code.
- Read [the configuration guide](docs/configuration.md) before changing defaults,
  providers, connectors, or deployment behavior.
- Do not add company-specific literals, credentials, contacts, vault content, or raw
  runtime data to the public base. Split mixed features into a generic Core Contract
  change and a private Vertical change.
- Maintainers publishing a reviewed public snapshot should follow the
  [public release maintenance guide](docs/public-maintenance.md), including
  the Ownward version, changelog, and Desk lock checks.

## Development setup

Ownward currently supports macOS and requires Bun and Git. Claude Code or Codex is needed for the corresponding AI features, but most unit tests do not require a live provider account.

```bash
git clone <your-fork-url>
cd ownward
bun install --frozen-lockfile
```

Use a development worktree and isolated local configuration. Do not point development runs at a real vault or copy production secrets into the worktree.

## Verification

Before submitting a pull request, run:

```bash
./verify.sh
```

The verification gate includes bundling, `tsc --noEmit`, unit tests, a test-mode daemon smoke test, API probes, and browser JavaScript parsing.

Include tests for behavior changes. For provider or agent integrations, test argument construction, event parsing, capability fallbacks, failures, and redaction without requiring contributors' real credentials.

For Vertical and Connector changes, also include manifest/capability validation,
stable event identity, retry/unknown-outcome behavior, data schema and migration
notes, and an explicit statement of whether the change is a key delivery path or
an at-most-once observation path.

## Pull requests

- Explain the user problem and the chosen behavior.
- Describe security, privacy, migration, and compatibility implications.
- Include verification evidence.
- Keep unrelated formatting and refactors out of the same pull request.
- Do not weaken Host/Origin checks, vault path validation, type checking, or human approval gates.

By contributing, you agree that your contribution is licensed under Apache License 2.0.
