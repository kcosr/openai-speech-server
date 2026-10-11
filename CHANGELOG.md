# Changelog

## [Unreleased]

### Added

- Local Realtime transcription with bounded recording sessions. ([#1](https://github.com/kcosr/openai-speech-server/pull/1))
- Per-model Realtime recording limits in capability discovery. ([#2](https://github.com/kcosr/openai-speech-server/pull/2))

### Changed

- Add reviewed source-release preparation and publication commands. ([#3](https://github.com/kcosr/openai-speech-server/pull/3))

### Fixed

- Update dependencies to resolve reported security advisories. ([#3](https://github.com/kcosr/openai-speech-server/pull/3))
- Reject Realtime timeouts above 2,147,483 seconds to prevent immediate session expiry. ([#2](https://github.com/kcosr/openai-speech-server/pull/2))
