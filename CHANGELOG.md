# Changelog

## [Unreleased]

### Added

- OpenAI-compatible Realtime transcription for local speech models, with
  client-controlled recording commits, final transcript events, and bounded
  sessions sharing the existing HTTP worker pools. Disconnects cancel owned
  work without replaying recordings.
  ([#1](https://github.com/kcosr/openai-speech-server/pull/1))
