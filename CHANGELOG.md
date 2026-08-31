# Changelog

All notable public changes to Ownward are documented here.

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
