# Changelog

All notable public changes to Ownward are documented here.

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

[1.1.2]: https://github.com/whtis/ownward/releases/tag/v1.1.2
[1.1.1]: https://github.com/whtis/ownward/releases/tag/v1.1.1
