# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `/effort max` now resolves to the model's true highest level, including `max` (e.g. deepseek-v4-flash) instead of capping at `xhigh`/`high`. Models that only support `max` (e.g. kimi-k3, gpt-5.6-luna) no longer error.

### Added
- `/effort max` toggle plus `/fast on|off` overrides for OpenAI/Codex priority service tier.
- Compact footer status keys for powerline custom items: `pi-effort-thinking` and `pi-effort-fast`.

### Changed
- Development dependencies moved to `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 0.83 (the renamed `@mariozechner` packages) so local type-check and tests cover the `max` thinking level.
- Simplified the slash-command surface to `/effort {min|minimal|low|medium|high|xhigh|max}` and `/fast [on|off]`.

## [0.0.5] - 2026-05-04

### Fixed
- Restored compatibility with Pi 0.72 by replacing the removed `supportsXhigh()` helper with `getSupportedThinkingLevels()`.
- Updated xhigh capability tests to use Pi's `thinkingLevelMap` metadata shape.

### Changed
- Updated development dependencies to Pi 0.72.1 for release verification.

## [0.0.4] - 2026-04-29

### Changed
- Replaced the direct `@mariozechner/pi-tui` runtime import for the effort shortcut with Pi's documented shortcut string form.
- Improved non-reasoning model messaging and model-switch UI sync.
- Effort changes now update Pi's working label when idle and keep active-run loader text tied to the run-start effort.
- Tab completion now keeps `off` and explicit default levels available even when the current model cannot think.

### Fixed
- Regenerated stale lockfile metadata for the current package version and dependency contract.
- Default settings writes now create the settings directory and clean up temporary files after failed writes.

### Added
- Integration coverage for the `--effort` startup flag, model-switch capability clamping, and registered argument completions.
- CI/package verification via `npm pack --dry-run`.

## [0.0.3] - 2026-04-23

### Changed
- Capability detection delegated to upstream `supportsXhigh()` from `@mariozechner/pi-ai`; removed local `DEFAULT_XHIGH_PATTERNS` and `supportsXhighThinking`. Extension now auto-adapts to new xhigh-capable models introduced upstream.
- Tab completion now filters thinking levels by the current model's capabilities.
- peerDependencies pinned to `>=0.69.0 <1.0.0` (was `*`) — protects against pre-1.0 upstream breaks.

### Fixed
- `package.json` version field corrected (was `0.1.0` despite CHANGELOG at 0.0.2).

### Added
- GitHub Actions CI running type-check and tests on Node 20/22.
- README attribution to upstream pi and Mario Zechner.

## [0.0.2] - 2026-04-23

### Added

- `/effort min` and `/effort max` — model-adaptive semantic aliases that resolve to the lowest/highest reasoning level for the current model
- `/effort default min` and `/effort default max` — set persistent defaults using the resolved level
- `Ctrl+Shift+E` keyboard shortcut to cycle through available effort levels
- `--effort` CLI flag (e.g., `pi --effort max`) to set initial effort on session start
- `session_start` hook — syncs visible effort UI and applies `--effort` flag on startup
- `model_select` hook — clamps effort when switching to a model with a lower max, with warning notification
- `cycleLevel()` — cycles through user-facing levels (powers the keyboard shortcut)
- `getUserFacingLevels()` — returns available levels excluding `off` for display/completion
- Typo suggestions using Levenshtein distance on invalid commands
- Atomic settings write (temp file + rename) to prevent partial writes and race conditions
- `getDefaultThinkingLevel()` safely returns `undefined` on corrupt/unreadable settings.json instead of crashing
- Pre-validation of effort level against model capabilities before calling `pi.setThinkingLevel()` — unsupported levels are rejected with a clear error instead of silently clamped

### Changed

- `buildShowMessage` is now a pure function (no disk reads; default level passed as parameter)
- `formatUsage()` function replaced with `USAGE` constant
- `off` is accepted for backward compat but hidden from the primary user surface — use `min` instead
- Tab completion now shows `min`/`max` alongside explicit levels
- README rewritten to document min/max, shortcuts, CLI flag, and model switching behavior

### Removed

- Silent clamping of effort levels (replaced with explicit rejection + error message)
- `formatUsage()` function (replaced by `USAGE` constant)
