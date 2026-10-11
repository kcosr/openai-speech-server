# Changelog

## [Unreleased]

### Added

- Local Realtime transcription with bounded recording sessions. ([#1](https://github.com/kcosr/openai-speech-server/pull/1))
- Per-model Realtime recording limits in capability discovery. ([#2](https://github.com/kcosr/openai-speech-server/pull/2))

### Fixed

- Reject Realtime timeouts above 2,147,483 seconds to prevent immediate session expiry. ([#2](https://github.com/kcosr/openai-speech-server/pull/2))
