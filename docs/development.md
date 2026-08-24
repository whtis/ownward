# Development guide

## Setup

Ownward currently supports macOS. Install Bun and Git, then clone the repository and
run:

```bash
bun install --frozen-lockfile
./verify.sh
```

Claude Code or Codex is only needed when manually exercising the corresponding
provider. Unit and contract tests must not require a contributor's account or
credentials.

Use an isolated worktree and an isolated `config.json` while developing. Never point
a test daemon at a real vault, copied `data/` directory, or provider secrets.

## Architecture boundaries

- Kernel owns Task, Run, Session, Action, Event, approval, durable storage and
  security policy.
- Providers normalize Agent CLI behavior inside the Runner. Their third-party API is
  experimental in this alpha.
- Connectors normalize external facts into events. They do not own domain models.
- Verticals own domain UI and workflows through capability-scoped Kernel APIs.

Do not weaken Host/Origin checks, vault path validation, durable command gates, or
human approval gates. A successful API response must mean that work was performed or
durably queued; unsupported behavior must fail explicitly.

## Verification

Run `./verify.sh` before opening a pull request. It builds the project, type-checks,
runs tests, starts an isolated daemon, probes core APIs, and parses web assets.

For a behavioral change, add a focused regression test. Provider and extension work
must cover malformed inputs, capability fallbacks, failure behavior, and redaction
without using real credentials.
