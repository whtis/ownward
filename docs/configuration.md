# Configuration

Ownward is local-first. It keeps a versioned default configuration in
`config.default.json` and reads personal overrides from `config.json`.

Use the dashboard's **Settings** tab for normal changes. It renders the public
and advanced configuration schema, validates a staged diff, requires an explicit
approval, writes only the local override, and restarts the paired daemon and Runner
through the release transaction.

`config.json`, `prompts/owner.md`, `data/`, provider credentials, and your vault are
local assets. They are intentionally ignored by Git and must never be committed.

## First run

On macOS, run `bash install.sh`. The installer creates `config.json` if needed,
installs the local daemon and Runner, and opens the dashboard at
`http://127.0.0.1:4517`.

After changing `config.json` directly, run `bash install.sh` again. The release transaction
uses a frozen configuration snapshot, so editing the file alone does not change a
running installation. Applying a change from Settings performs this transaction
automatically.

The Settings page includes provider and connector switches, owner and vault
preferences, notifications, Heartbeat and digest schedules, Dashboard listening,
and the default directory, provider, model, and permission for newly dispatched
tasks. New Routine definitions and prompt text remain file-based.

## Common overrides

```json
{
  "owner": { "name": "Your name" },
  "vault": { "root": "~/Documents/ownward-vault" },
  "llm": { "engine": "codex" },
  "architecture": {
    "allowedRoots": ["/Users/you/workspace"]
  }
}
```

`architecture.allowedRoots` is an explicit grant for directories where development
tasks may run. Use the smallest useful roots. An empty array disables development
task dispatch rather than granting broad access.

Providers and event sources are opt-in. The checked-in defaults contain no account,
token, path, or external endpoint and keep connectors disabled. Enable only the
provider or connector you have configured locally; see `config.default.json` for the
complete schema and defaults.

## Remote access

The dashboard listens on localhost by default. Change **Settings → Advanced →
Dashboard → Listening scope** to enable LAN access, or set
`dashboard.listen: "all"` manually. This is a high-risk setting and requires an
extra confirmation. Use a trusted TLS network layer such as Tailscale or a reverse
proxy and protect the generated API token. Ownward automates tools with your
local-user permissions; it is not a sandbox.
