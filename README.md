# Ownward

> Your work, carried forward.

## AI sessions end. Development work should not have to start over.

Ownward is a local AI workbench for developers. Dispatch work from your phone,
let Claude Code, Codex, or CodeBuddy take turns, and bring the execution facts
from every agent back into one project memory.

Ownward is early alpha software. The command-line entry point is `own`.

Once AI is part of your development workflow, the hard problem is usually not
that a model cannot write code. The hard problem is continuity: you leave your
desk and lose the thread; Claude hits a limit and switching to Codex means
explaining everything again; several CLIs change the same project with no single
record of what happened; and writing a status update means searching through
chat logs and Git history all over again.

Ownward runs on your Mac and keeps tasks, project directories, and work records
together. Android and iPhone act as remote workbenches. Your code, credentials,
and agent CLIs stay on the Mac.

## Five ways Ownward helps with development

### 1. Code from Android or iPhone without adding another provider

Connect your phone to Ownward on the Mac to dispatch a development task, choose
the project directory, add extra directories, select a model, and set access
permissions. You can watch streaming replies, tool calls, and images; ask a
follow-up question; interrupt a task; switch engines; and inspect repository
status, diffs, tests, commits, and pull requests.

The Android client is available from [GitHub Releases](https://github.com/whtis/ownward/releases).
The iPhone client requires **iOS 26+** and can be installed on a device with
Xcode. TestFlight distribution is provided by the maintainer. See
[ios/README.md](ios/README.md) for build instructions.

Neither mobile client copies your code to the phone for execution. Remote access
uses a token. Put Ownward behind Tailscale or a trusted TLS proxy instead of
exposing the local port directly to the public internet.

Ownward can use Claude Code, Codex, and Tencent CodeBuddy. Configuring only
CodeBuddy still gives you the complete task workflow without access to an
overseas provider. Ownward is not a proxy and does not change the network
requirements of Claude or Codex.

### 2. Continue task sessions and ordinary chats across engines

When you switch the engine for a task session, Ownward creates a traceable
successor session. The new engine receives a bounded slice of recent history and
inherits the original working directory, extra directories, and access level.
The handoff prompt tells it to inspect the actual Git and file state instead of
replaying old tool calls. The previous chain stays available for review, and an
operation with an unknown result must be confirmed by a person before another
engine takes over.

```text
Claude Code --rate limit--> Codex --different capability--> CodeBuddy
      `----------- the old session and execution record stay available --------'
```

Ordinary Chat switches differently. Change the provider in an existing
conversation and Ownward replays the chat history as context. It does not create
a task successor chain and does not carry task workspace state. That is useful
for discussion and advice. Use a task session when the conversation needs to
operate on real code.

### 3. Put all three agents' execution facts back in one project

Tasks dispatched to Claude Code, Codex, or CodeBuddy create the same Run and
Flight Record structure. The goal, execution trail, code changes, commit, and
conclusion return to the project in one format, no matter which agent handled
the turn.

### 4. Harvest sessions into durable project memory

Substantive sessions started in external Claude Code or Codex CLI are discovered
and harvested automatically. CodeBuddy's private transcript cannot currently be
read from outside, so only CodeBuddy tasks started by Ownward are harvested.

Harvested material is written to a local Markdown vault: recent material goes to
the inbox, project evolution goes to the log, and task facts go to flights. When
the model suggests long-term knowledge, it first writes to `_candidates/`; a
person confirms it before it becomes official project memory. The next task can
reuse those records instead of hoping an agent remembers the last conversation.

### 5. Draft recurring updates from the work that already happened

Routines fit recurring responsibilities such as stand-ups, weekly reports, and
project syncs. At the scheduled time, Ownward gathers recent harvested records,
task results, and project memory into a draft for review.

A person must approve the draft before it is written to a Feishu document.
Ownward gathers and drafts the material, but it does not skip the final
publishing decision. Routines are off by default. Start with
[examples/routines.json](examples/routines.json) when configuring
`data/routines.json`; see the [configuration guide](docs/configuration.md) for
Feishu setup and the rest of the configuration surface.

## Quick start

The server currently runs on macOS and needs:

- [Bun](https://bun.sh)
- Git
- A logged-in [Claude Code](https://claude.com/claude-code) or [Codex CLI](https://github.com/openai/codex)
- Optional: [Tencent CodeBuddy](https://copilot.tencent.com)

```bash
git clone https://github.com/whtis/ownward.git
cd ownward
./install.sh
open http://127.0.0.1:4517
```

The installer creates local configuration and starts the daemon and an isolated
Runner through launchd. The workbench listens on `127.0.0.1:4517` by default.

To use only Codex, set this in the generated `config.json`:

```json
{
  "llm": { "engine": "codex" }
}
```

CodeBuddy is off by default. Enable it with
`providers.codebuddy.enabled: true`.

## How work gets carried forward

```text
Start a task from phone, Web, or Terminal
                    |
         Claude / Codex / CodeBuddy
            hand off when needed
                    |
          Run / Flight Record / diff
                    |
          Harvest into project material
                    |
       A person promotes candidate knowledge
              into the current truth
                    |
        The next task and Routine reuse it
```

This loop is not about saving more chat. It gives the next development session
the facts left by the last one. The vault is ordinary Markdown that you can
search, edit, commit to Git, or manage with Obsidian. The default location is
`~/Documents/ownward-vault/`.

## The same Kernel can host other workbenches

The development workbench is Ownward's built-in `dev` Vertical. Its Kernel,
independent Runner, provider adapters, fact storage, and permission layer do not
depend on the specific domain of writing code.

The Vertical contract defines controlled capabilities such as sessions, tasks,
actions, storage, scheduler, LLM, and sources. A built-in Vertical can request
capabilities through that contract. The external Host currently exposes storage,
actions, scheduler, LLM, and sources; sessions and tasks remain blocked by the
Host availability gate. An external Vertical can also mount its own API routes,
pages, and navigation, and can run in a separate Host process for crash
isolation and development-time hot reload.

The included Desk extension is aimed at recruiting workflows. It uses the same
engine chain, Actions, scheduler, storage, and sources while keeping the full
domain implementation outside this repository. The public [read-only Vertical
example](examples/verticals/sample-readonly) uses scoped storage to show a
sanitized candidate list and verify Host, routing, page, and authorization
boundaries.

The same approach works for other personal workbenches. An external Vertical
must be trusted local code explicitly enabled by the user. A separate process
isolates crashes and lifecycle, but it is not a security sandbox. See the
[development guide](docs/development.md) for the extension contract and
development rules.

## Capabilities and boundaries

| Capability | Claude Code | Codex | CodeBuddy |
|---|---:|---:|---:|
| Dispatch, continue, and supervise inside Ownward | ✓ | ✓ | ✓ |
| Cross-engine task-session handoff | ✓ | ✓ | ✓ |
| Continue ordinary Chat across engines | ✓ | ✓ | Configurable |
| Put Ownward tasks into the unified record | ✓ | ✓ | ✓ |
| Harvest sessions from external CLIs | ✓ | ✓ | — |
| Work without an overseas provider | — | — | ✓ |

Ownward is not an IDE or an agent security sandbox. It keeps work continuous;
it does not replace Claude Code, Codex, CodeBuddy, or Git. It also cannot yet
import the complete history from ChatGPT or the Claude web app.

## Dispatch a task

Use the workbench or the CLI:

```bash
# Start Claude Code in Terminal so you can take over at any time
bin/own work ~/workspace/example "Fix the login-page crash"

# Run in an isolated worktree in the background
bin/own work ~/workspace/example "Add missing unit tests" --bg
bin/own work ~/workspace/example "Refactor the utils directory" --bg --codex

bin/own tasks
bin/own done <id>
```

Background tasks run in an isolated worktree by default. A worktree reduces the
risk of changing the main checkout by accident, but it is not a permission
sandbox.

## Workbench tabs

- **Today**: Actions, agent wrap-up, Routines, and calendar items that need attention
- **Tasks**: Dispatch, observe, ask follow-up questions, approve, take over, or hand off a task
- **Chat**: Ordinary Chat, with provider switching inside an existing conversation
- **Feed**: Triage results from external events
- **Notes**: Browse and edit the Markdown vault
- **System**: Event sources, schedules, logs, and runtime status

GitHub, Feishu, Gmail, and stock event sources are off by default. Without any
external account, you can still use task dispatch, session harvesting, project
records, Actions, Heartbeat, notes, and macOS notifications.

## Configuration and security

Ownward uses two configuration layers. The checked-in `config.default.json`
contains defaults, while the local `config.json` contains only overrides and is
never committed. These files adjust common behavior:

- `prompts/owner.md`: which people and events matter, plus writing preferences;
- `prompts/heartbeat.md`: the proactive check list;
- `data/routines.json`: recurring responsibilities.

After changing configuration, run `bash install.sh` so the Runner and daemon
switch to the same frozen configuration snapshot. See the full
[configuration guide](docs/configuration.md).

Local storage and a local control plane do not mean the model runs locally.
Content sent to a provider is covered by that provider's terms, and an agent may
run commands or change files with the current user's permissions. Never commit
`config.json`, `prompts/owner.md`, `data/`, the vault, credentials, or raw
transcripts to Git.

The Dashboard validates Host and Origin headers. See [SECURITY.md](SECURITY.md)
for the security boundary and reporting process.

## Architecture and development

Ownward is a Bun / TypeScript daemon with an embedded static Web workbench and no
runtime npm dependencies. Provider tasks run in an independent Runner. During a
daemon update or restart, the Runner drains safely instead of marking active
tasks as successful.

Read the [architecture guide](docs/architecture-v1.md) and the
[development guide](docs/development.md) before changing the project. Start
development with:

```bash
bun install --frozen-lockfile
./verify.sh
```

The verification gate builds the project, runs the TypeScript type checker and
unit tests, smoke-tests an isolated daemon, probes the API, and parses the Web
JavaScript. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process.

Ownward is licensed under the [Apache License 2.0](LICENSE).

## Remote access from a phone

Enable remote listening in `config.json`, then reinstall:

```json
{
  "dashboard": { "listen": "all" }
}
```

```bash
bash install.sh
```

Ownward will listen on `0.0.0.0:4517` and require a remote access token. Use a
firewall or router to block direct public access to port 4517, and expose only
the HTTPS entry point below. The first phone visit asks for the token stored in
`data/secrets/api-token.txt`.

### Nginx

Configure a valid TLS certificate for your domain, then add a server block like
this:

```nginx
server {
    listen 443 ssl;
    server_name ownward.example.com;

    # The first login uses a query parameter. Do not write the full request to access logs.
    access_log off;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4517;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Reload Nginx, then open `https://ownward.example.com` on the phone.
`X-Forwarded-For` makes Ownward apply token authentication to the remote
request. `X-Forwarded-Proto: https` makes the login cookie use `Secure`.

### Cloudflare Tunnel

Cloudflare Tunnel does not require an inbound router port. Install `cloudflared`
and prepare a domain connected to Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create ownward
cloudflared tunnel route dns ownward ownward.example.com
```

Put the Tunnel UUID and credentials path returned by those commands in
`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/you/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: ownward.example.com
    service: http://127.0.0.1:4517
  - service: http_status:404
```

Start and verify the tunnel:

```bash
cloudflared tunnel run ownward
```

After confirming that the phone can connect, follow the [Cloudflare
documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
to register the Tunnel as a persistent macOS service.

The first login briefly uses a token in a query parameter, then exchanges it for
an HttpOnly cookie. Do not log query strings, copy this login URL, or capture it
in a screenshot. Exclude query parameters from Cloudflare logs, monitoring, and
analytics too. If the token may have leaked, delete
`data/secrets/api-token.txt` and run `bash install.sh` again so every client must
log in again.

If you mainly use a browser, you can also enable Cloudflare Access. Before
connecting the native Android or iOS clients, confirm that their authentication
flow is compatible with the Access policy. Keep Ownward's own access token even
when Access is enabled. See the [Nginx reverse-proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
for the proxy directives.

---

**Ownward - your work, carried forward.**
