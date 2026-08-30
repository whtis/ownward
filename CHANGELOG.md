# Changelog

All notable public changes to Ownward are documented here.

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

[1.1.6]: https://github.com/whtis/ownward/releases/tag/v1.1.6
[1.1.5]: https://github.com/whtis/ownward/releases/tag/v1.1.5
[1.1.4]: https://github.com/whtis/ownward/releases/tag/v1.1.4
[1.1.3]: https://github.com/whtis/ownward/releases/tag/v1.1.3
[1.1.2]: https://github.com/whtis/ownward/releases/tag/v1.1.2
[1.1.1]: https://github.com/whtis/ownward/releases/tag/v1.1.1
