# Changelog

All notable changes to Browser2IDE will be documented in this file.

## [0.2.0] - Unreleased

### Added

- Automatic per-window VS Code bridge startup and seven-digit link-code copying.
- Firefox Stable 142+ and Chrome/Chromium 116+ DevTools extensions with a shared
  browser-window coordinator.
- Explicit browser-window linking, Change IDE, Unlink, and Inspect controls.
- Built-in CSS and source-mapped SCSS resolution for the active VS Code
  document.
- A versioned public source-plugin API and authoring guide for separately
  installed VS Code extensions.
- Preparation for VSIX, Chrome ZIP, and signed Firefox XPI release artifacts;
  these packages are not published yet.

### Changed

- Upgraded the read-only browser-to-IDE contract to protocol v3 with explicit
  authenticated link and unlink messages.
- Scoped session mappings to browser windows so same-window DevTools panels can
  multiplex through at most one active WebSocket while panels are active.
- Kept inspection opt-in: Inspect never starts or resumes automatically.

### Security

- Restricted the IDE bridge to loopback WebSockets and rejected webpage
  origins, invalid credentials, oversized messages, and unsupported protocol
  input.
- Limited content-script injection to inspected tabs whose DevTools panel is
  open, browser window is linked, and Inspect is explicitly enabled.
- Documented required browser permissions, trust boundaries, collected facts,
  sensitive-value risks, private vulnerability reporting, and the absence of
  analytics or a remote Browser2IDE service.
