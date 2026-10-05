# Changelog

## [Unreleased]

### Added

- Authorized transcription model capabilities now include effective Realtime
  buffer, message, output, idle and session limits derived from existing server
  and model settings. Clients can validate recording limits before capture;
  buffer limits are rounded down to whole PCM16 samples.
- OpenAI-compatible Realtime transcription for local speech models, with
  client-controlled recording commits, final transcript events, and bounded
  sessions sharing the existing HTTP worker pools. Disconnects cancel owned
  work without replaying recordings.
  ([#1](https://github.com/kcosr/openai-speech-server/pull/1))

### Fixed

- Realtime idle and session limits reject values above 2,147,483 seconds,
  preventing Node timer overflow from expiring an advertised long session immediately.
