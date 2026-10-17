# Changelog

All notable public changes to Ownward are documented here.

## [1.7.0] - 2026-10-17

### Added

- Verticals can notify you and publish events (ADR 0003). `ctx.notify.send()` goes through the same notification policy as Ownward's own notifications, including quiet hours, focus suppression and cooldowns. The source and key are always prefixed with the Vertical's id, links must be http(s) or point to the Vertical's own pages, urgent delivery needs a local grant, and each Vertical is rate limited. `ctx.events.publish()` feeds the event queue, where triage decides how each event is graded; a batch is validated as a whole, deduplicated across restarts and rate limited. Both capabilities are also available to external Vertical hosts. `KERNEL_API_VERSION` is unchanged.
- Staged Actions (off by default, `staging.enabled`). Once an action has been open for a while (10 minutes by default), Ownward prepares a reply draft for Lark and Gmail threads, or a review brief for GitHub pull requests, and shows it in the action's draft panel. The draft is dropped if the action is handled or its input changes in the meantime, a daily budget caps the model calls, and nothing is ever sent until you click.
- The Today page has an assistant shelf for heartbeat observations that don't need a notification: suggestions, risks and recurring patterns, each with the evidence behind it. You can dismiss an observation or adopt it, which dispatches a task or opens an action. Observations expire after 72 hours, and adopting one that refers to an action already in the queue points to that action instead of opening a duplicate. Action cards that look like a failure get a one-click Investigate button that dispatches a root-cause task.
- The Today page shows your active roles in an avatar strip with their current state (on duty, working, needs attention), worked out from running tasks, open actions, uncommitted changes and how recent the project log is. A weekly Active Goals panel lists the open items for the current week in `memory/goals.md` and lets you tick them off.
- Routines can be closed without a draft: skip a routine from its card, mark it as already filled in by hand, or skip every overdue routine at once.
- Support investigations (off by default, `support.enabled`). Send the bot a direct message that starts with the trigger word (`排查` by default), and Ownward routes the report to one of the roles you listed in `support.roles`, runs a one-off read-only investigation as that role in a sandbox (only the commands in `support.allowedCommands` may run, and the credential files in `support.denyRead` can't be read), and sends the conclusion card to you alone. Your verdict is written back to the role's project log, and a correction becomes a project memory candidate.
- Session share images. Select messages in a session, or highlight just a passage, and Ownward draws them on your machine as a note-style image with an Ownward footer. You can edit the title, choose one of four styles and hide local paths and secrets (on by default), then copy, download or share the image.
- English is a first-class language. The README is now in English, with the Chinese version in `README.zh-CN.md`; the install scripts print English or Chinese according to the system language (`OWNWARD_LANG` overrides it); and the web dictionary covers the strings that were still missing.
- `own stage [--ref <branch>]` runs a pre-release next to production. It fast-forwards a separate dev checkout to the branch, runs the verification gate, and starts a dev instance on port 4519 from a copy of your configuration with event sources, notifications, background jobs and vault sync turned off. It then smoke-tests every workbench page in headless Chrome. `own stage promote` only accepts a commit that passed.

### Changed

- A Claude session dispatched with per-approval permissions can be switched to "allow all" while it runs. The session header has an approval-mode toggle and approval cards have an "Allow all" button; tool approvals already pending in the current turn are granted and audited, while questions still wait for your answer. The "Always" option now says which kind of command it will remember.
- Actions can carry an expiry time, and project memory candidates record the date of the source they came from. The Roles page can filter candidates by source date and dismiss them in bulk; promotion is still one at a time.
- Work logs for long tasks are written from the task's conclusions and changes instead of the first part of its command log, and the flight record lists the final answer of every round instead of only the last one.

### Fixed

- Dispatching to a directory that is not a git repository runs the task in place instead of failing to create a worktree, and a repeated system notice in a session is shown once.
- A failed check for the Claude CLI's `--effort` support is no longer cached until the Runner restarts, and the check now waits up to 10 seconds instead of 2. Right after a CLI upgrade, sessions that set a reasoning effort used to be refused.
- Codex warnings about unrecognised `config.toml` settings are shown once as non-fatal warnings and no longer hide the real reason a round failed. Failure lines include the exit code.
- The sender of a Lark message is no longer lost when the event is normalised more than once.
- The scope hint on the "Always" approval button is fully translated in the English interface.

## [1.6.0] - 2026-10-15

### Added

- Roles are generated and maintained automatically. Dispatching a task into a git repository gives that repository a project owner role on first use, and the task goes to it with the project's memory attached to the first message: README, decisions, operations notes and the recent work log. An owner you archive is not recreated.
- When a task spans several projects and no role covers all of them, the dispatch dialog and the Roles page offer to create a cross-project role that reads the memory of every project involved. The Roles page also suggests such roles from recent work that touched several projects.
- Domain roles cover work that has no repository, such as operations or device maintenance done from a workspace root. When a task is dispatched from a directory that is not a git repository, its description is matched against the domain roles: a role is attached only when the match is confident, otherwise the dialog lists the likely candidates and asks you to pick one. Work done in such directories is filed under the matched domain role when it is harvested.
- A role can record former project names, so the notes of a renamed project are read as history next to the current memory.
- The iOS and Android apps support roles. The dispatch form shows which role will take the task and offers cross-project roles and domain-role candidates, and a Roles screen lists project owners, domain roles, cross-project roles and suggestions.
- Decisions that the daily digest extracts for a specific project are filed as that project's memory candidates and reviewed on the Roles page. Promotion is still manual.

### Changed

- `llm.roleMatchModel` (default `haiku`) chooses the model for domain-role matching. Matches are cached per description, concurrent requests for the same description share one call, and both the dispatch preview and the dispatch itself stop waiting for the model after a few seconds.

### Fixed

- Claude sessions no longer report a missing result when the main thread stays silent during a background report, and session notices are translated in the English interface.
- The mobile dispatch form no longer shows a stale error or applies a stale role preview after the directory or description changes.

## [1.5.0] - 2026-10-10

### Added

- Sessions can be forked. A fork opens a new session that carries the full context of the original, and the original stays usable, so you can try a different direction without losing the thread you were on.
- The web workbench has an English interface, switchable in Settings. Generated task titles follow the selected language: with English selected, new tasks get English titles even when the task itself is written in Chinese. Existing titles are left as they are.
- The notes page remembers where you were, saves as you type, and can search and jump between notes.

### Changed

- Long session histories load in pages. The web page and the iOS and Android apps fetch only the most recent part of a session (`/api/dev/messages?tail=N`) and load earlier messages on demand, and the web page renders only the latest 200 items and builds collapsed tool groups lazily. Very long sessions used to exhaust the browser tab's memory and crash it.
- Task detail polling dropped from every 2.5 seconds to every 10 seconds and stops for finished tasks.
- The "default" model in the dispatch dialog follows the CLI's own configuration instead of a hard-coded model.

### Fixed

- Background subagents started by Claude are no longer killed when the turn ends; their reports land in the same run, and a background task that finishes in the turn that started it is no longer labelled as left over from a previous turn.
- Provider errors show their details instead of a bare `provider_input_invalid`.
- The release canary uses a copy of the credentials without the refresh token, so installing a release no longer signs you out of the CLI.

## [1.4.0] - 2026-09-20

### Added

- Notifications are graded by whether they need you to act. Only the ones that do reach Lark, and they arrive as a card that states what happened, the context behind it (project, reason, exit code) and a button that opens the right page. Everything else stays in the feed and the desktop banner. Previously every task that finished was pushed to Lark, so the pushes that mattered were buried.
- Notifications are suppressed while the workbench window is focused and you are actually working in it, because the feed in front of you already shows them. The window reports its focus every 30 seconds and stops reporting once it loses focus or sits idle, so the Lark fallback still fires when you walk away.
- Repeated notifications about the same thing are collapsed for 30 minutes. A relayed session reaps a run at the end of every turn, which used to announce "task finished" each time.
- Time-critical notifications (meeting reminders, stop-loss alerts) are exempt from quiet hours, and manually triggered test notifications bypass every suppression rule and report honestly whether a channel accepted them.
- Isolated worktrees for coding tasks are cleaned up by whether deleting them would lose anything, and the daemon reclaims the landed ones daily. Deleting a worktree collapses its group in the workbench and archives the tasks inside it.
- Routine drafts (daily and weekly reports) first read back what you previously wrote by hand in the target document, so a draft reconciles against last period's plan instead of restating the raw work log.

### Fixed

- A vault sync that cannot reach its Git remote is no longer reported as a conflict with another machine. Transport failures (SSH, DNS, proxy drops, timeouts) retry silently; only a real rebase conflict raises a notification, and it names the repository and the exact steps to resolve it.
- Meeting reminders reach Lark. They were tagged with the `lark` source, which the "do not echo Lark events back to Lark" rule skipped, so the one notification type with a join button never arrived.
- Bare URLs in session and chat bubbles are clickable. Only `[text](url)` markdown links were rendered, so a pasted link had to be copied by hand.
- Session history projection is no longer truncated at 200 messages or 128K, so a relayed session keeps its full history.

## [1.3.0] - 2026-09-17

### Added

- Task and session composers accept arbitrary file attachments, not just images. Files are stored on the server and their absolute paths are appended to the message, and the directory holding them is granted to the agent so it can read them with its own tools. Images keep travelling inline as before.
- The Today page has a multi-select mode that completes, dismisses, or snoozes many action items at once, so a queue of items that need no individual judgement can be cleared in one pass.
- Recent sessions can be archived from the list. Archiving hides a session without touching anything on disk, and a session that sees new activity afterwards returns to the list on its own. Archived sessions remain fully searchable.
- CodeBuddy can serve as the decision engine and as the failover engine, alongside Claude and Codex.
- Two built-in "Ink" appearance skins (dark and light).

### Fixed

- Approvals raised by CodeBuddy sessions can now be answered. The CLI has no `--permission-prompt-tool` flag, which had been read as "no approval bridge"; the bridge is actually the stream-json control channel, which CodeBuddy speaks. Previously the approval card appeared but could not be answered, and the turn hung until the Runner restarted.
- Engines disabled through `providers.<id>.enabled` no longer appear in the dispatch dialog, where selecting one could only fail.

## [1.2.8] - 2026-09-17

### Fixed

- Image attachments in the task composer and the dispatch dialog are now type-checked, HEIC-converted, and downscaled locally before upload, so a phone screenshot no longer fails after the upload with an attachment size error. Pasting several images at once no longer drops all but one.
- Incoming image attachments are validated server-side on the session paths as well (type allowlist, magic-byte sniffing, canonical base64, per-image and per-message size caps), matching what the AI chat path already enforced.
- Releasing and re-acquiring session input control is reflected in the session state immediately, so the "take over input" button reappears after a release instead of leaving the session unreachable.

## [1.2.7] - 2026-09-15

### Fixed

- Runner approval rules now resolve handoff sessions to their owning task and trigger the approval sweep immediately, so “always approve” works reliably without waiting for the periodic sweep.

## [1.2.6] - 2026-09-15

### Fixed

- Routine draft editor on Android keeps its Close / Save / Save and write actions above the text, so they stay reachable on devices where the full-screen dialog pushed the bottom row off screen.
- Image attachments on user messages are right-aligned with the user bubble on Android and iOS; agent images stay on the left.

## [1.2.5] - 2026-09-15

### Added

- Mobile settings now groups update status, source code, project homepage, version, and license details in one consistent About section.
- Android and iOS keep a visible update indicator after an update is deferred, and reuse the existing GitHub Pages update channel with daemon fallback.

### Fixed

- Mobile update metadata and download links now follow the public release channel consistently.

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
