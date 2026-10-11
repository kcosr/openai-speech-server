# Repository guide

Run installs, tests, and builds with `NODE_ENV` unset. Use `npm ci`,
`npm run check`, and `npm run build`. Audio tests require ffmpeg; set
`OPENAI_SPEECH_FFMPEG` to an audio-capable executable when necessary.
Real model/GPU and deployed-server smoke checks are separate from fixture tests.

## Changelog and releases

Record user- and operator-visible changes under `[Unreleased]` in
`CHANGELOG.md`. Keep entries concise, describe upgrade effects, and include
PR links before merging. Use Added, Changed, Fixed, Removed, and Breaking
Changes only as needed; omit empty or duplicate subsections. Preserve published
release entries. Keep implementation detail in the reference documentation.

Follow [Release process](docs/release-process.md). Prepare on a clean branch
with `npm run release:prepare -- X.Y.Z` (or `patch`, `minor`, `major`), review
and merge the version/changelog changes, then publish only when requested with
`npm run release:publish -- X.Y.Z` from clean `main` matching origin. Both
commands support `--dry-run`. Releases are source-only annotated tags and
GitHub releases; publishing does not deploy or publish an npm package.

Keep package and lockfile versions synchronized using `scripts/version.mjs`.
Product versions are independent of the worker protocol version. Changes to
release helpers require `npm run test:release`; its disposable Git repositories
and simulated GitHub CLI must not publish anything externally.
