# Security Policy

## Supported versions

Ownward is currently in alpha. Security fixes are applied to the latest version on the default branch; older commits and forks are not maintained.

## Reporting a vulnerability

Please do not open a public Issue for vulnerabilities, credentials, private logs, or reproducible exploit details.

Use GitHub Private Vulnerability Reporting on this repository. Include:

- the affected version or commit;
- the relevant configuration and platform;
- reproduction steps and impact;
- any suggested mitigation;
- sanitized logs only, with tokens, personal content, paths, and identifiers removed.

If private reporting is not enabled yet, open a public Issue containing no sensitive or exploitable details and ask the maintainer to provide a private reporting channel.

## Security model

Ownward is a local-first automation tool, not a security boundary:

- the dashboard listens on localhost by default;
- remote access requires a token and should be placed behind Tailscale or a trusted TLS proxy;
- coding agents may execute commands and modify files with the current user's permissions;
- worktrees reduce accidental changes to a main checkout but are not sandboxes;
- content sent to configured AI providers or external integrations leaves the local machine;
- long-term memory promotion, routine publication, and self-evolution deployment retain human approval gates.

Never commit `config.json`, `prompts/owner.md`, `data/`, vault content, OAuth credentials, API tokens, or raw conversation transcripts.
