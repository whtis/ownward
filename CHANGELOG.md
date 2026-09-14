# Changelog

All notable public changes to Ownward are documented here.

## [1.2.4] - 2026-09-15

### Fixed

- Recent session cards label each session with the engine that is currently running it. A session handed off to another engine is no longer shown with the engine it was originally dispatched to.

## [1.2.3] - 2026-09-14

### Fixed

- Runner approval rules remembered from the “always approve” action now apply to matching requests, preventing repeated approval prompts.
- Claude approval replies no longer wait for a nonexistent CLI acknowledgement, so accepted approvals complete promptly.

## [1.2.2] - 2026-09-14

### Added

- Codex models and their supported reasoning levels now come from the CLI's own official catalog (`~/.codex/models_cache.json`), so new models such as GPT-6-Astra appear without a code change; a built-in snapshot is only a fallback. Exposed to clients as `/api/providers/catalog`.
- Switching the model or reasoning depth within the same engine now happens in place: the native session is resumed with the new parameters instead of creating a handoff session with a truncated transcript. Mobile clients get this automatically through the existing handoff API.
- The session composer understands `/model <name>` and `/effort <level>` (Web) and shows Ownward's own slash commands for Codex sessions too.
- Claude Code and CodeBuddy reasoning levels, and the CodeBuddy model list, are parsed from each CLI's `--help`; Claude models also include the account's server-provided extra models from `~/.claude.json`. CodeBuddy gains its `minimal` level.
- Session lineage: the session state now lists every session in a handoff chain (and refs rotated by `/new`) with its native session ID and a ready-to-paste resume command per engine (`claude --resume`, `codex resume`, `codebuddy --resume`). Web shows it as a collapsible panel; Android and iOS show it in the session info sheet, and their headers now show engine · model · depth.

### Changed

- Chat replies start much sooner: Claude chats keep one resident `claude` process per conversation (the CLI cold start of roughly four seconds used to be paid on every message), and Codex chats resume their native thread with streamed increments instead of replaying history and returning one block at the end.
- The built-in Codex model lineup follows the official catalog of 2026-09-05: GPT-6-Astra and GPT-5.3-Codex-Spark added, GPT-5.4 removed.
- The built-in CodeBuddy model lineup follows `codebuddy --help` of 2026-09-05 (hy3-x, glm-5.3, kimi-k3-2, deepseek-v4-flash and more; retired ids removed).

### Fixed

- The dispatch dialog on the Web no longer keeps the previously chosen engine while resetting the model to the configured default, which produced impossible combinations such as Codex with `opus`.

## [1.2.1] - 2026-09-02

### Added

- iOS can now review routine drafts like Android: view, edit, save, save-and-write, retry, and stale-draft warnings.
- Skill tidy-up shows live progress and diagnostics instead of a single disabled button.
- Settings can enable or disable installed extensions, and the settings entry moved into the overflow menu with extension entries following their enabled state.

### Changed

- Quick notes moved to the Today page and state where they are written.
- The draft review dialog on the Web can be resized freely and no longer loses edits when closed.

### Fixed

- The dispatch dialog shows recent directories again as an always-visible chip row, and the configured default directory has `~` expanded before it reaches clients.
- Routine draft review on mobile browsers and Android keeps the editor above the on-screen keyboard.
- Skill tidy-up no longer times out by default, explains zero-suggestion results, and stops flagging managed multi-engine deployments as duplicates.
- The Skill approval gate compares writable roots only, so read-only roots refreshed by external tools no longer veto manual approvals.
- Skill suggestions use plain language, keep primary actions in a sticky top bar, and center their dialogs.
- Codex sessions are no longer reported busy between the final frame and cleanup, so queued messages are no longer silently dropped.
- Removed a stale scheduled sync whose timeouts caused cascading false failures.

## [1.2.0] - 2026-08-31

### Added

- Added model and reasoning-depth selection when dispatching tasks, with live session reconfiguration across Web, Android, and iOS.
- Added GPT-5.6 Sol as the default Codex model while keeping explicit model choices available.

### Changed

- Android and iOS now reopen the last selected Inbox, Agent, or Chat area after relaunch while preserving the first-launch Chat experience.

### Fixed

- Restored visible Codex conversation history for current rollout formats and large sessions, including returned tool images.
- Limited harvested Git evidence to commits attributed to the configured owner identity.
- Consolidated identical Skill deployments into one manageable entry and made multi-location adoption visibly actionable.

## [1.1.9] - 2026-08-31

### Fixed

- Fixed messages being silently swallowed when resuming a session that left a
  background task running. Claude Code replays the stale background-task
  notification as its own pseudo turn, whose result was mistaken for the
  turn's own; the session is now kept alive and the notification is surfaced in
  the conversation.

## [1.1.8] - 2026-08-30

### Added

- Settings can now control Dashboard listening scope and the default directory,
  provider, model, and permission used when dispatching a new task.

### Changed

- Updated the English and Chinese setup documentation to use the Settings page
  for everyday configuration, while keeping manual file editing as a fallback.

## [1.1.7] - 2026-08-30

### Fixed

- Restore owner write permission before recovering a read-only stale release
  lock on macOS runners.

## [1.1.6] - 2026-08-30

### Fixed

- Removed the public exporter's dependency on `rg`, so the fallback metadata
  parser works on a clean GitHub Actions macOS runner.

## [1.1.5] - 2026-08-30

### Changed

- README now includes English and Simplified Chinese sections with language
  links, so the public project overview is readable in both languages.

## [1.1.4] - 2026-08-30

### Fixed

- Added the missing release link for the `1.1.3` changelog entry.

## [1.1.3] - 2026-08-30

### Changed

- Added an English README so developers can discover Ownward's workflow,
  architecture boundaries, configuration, and remote-access setup.

## [1.1.2] - 2026-08-29

### Added

- Added a public extension and contribution contract for separating reusable
  Kernel capabilities from external Vertical and Connector implementations.

### Changed

- Clarified contribution boundaries, data handling, capability requests, and
  verification expectations for extensions.

## [1.1.1] - 2026-08-28

### Added

- Added a settings and skills control plane for reviewing configuration and extension changes before applying them.
- Improved the public release workflow so downstream clients can pin an Ownward version and commit together.

### Changed

- Improved settings navigation and system status presentation across the web workbench.
- Hardened extension, connector, session, and deployment recovery paths.

[1.1.8]: https://github.com/whtis/ownward/releases/tag/v1.1.8
[1.1.7]: https://github.com/whtis/ownward/releases/tag/v1.1.7
[1.1.6]: https://github.com/whtis/ownward/releases/tag/v1.1.6
[1.1.5]: https://github.com/whtis/ownward/releases/tag/v1.1.5
[1.1.4]: https://github.com/whtis/ownward/releases/tag/v1.1.4
[1.1.3]: https://github.com/whtis/ownward/releases/tag/v1.1.3
[1.1.2]: https://github.com/whtis/ownward/releases/tag/v1.1.2
[1.1.1]: https://github.com/whtis/ownward/releases/tag/v1.1.1
