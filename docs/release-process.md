# Release process

Releases consist of an annotated `vX.Y.Z` Git tag and a GitHub release with
notes from `CHANGELOG.md`. GitHub supplies source archives. There is no npm
publication, binary upload, or deployment step. The private package version
identifies the product; worker protocol versions change independently.

## Prepare

Use Node.js 22 or newer, a clean branch, and `origin` pointing to
`kcosr/openai-speech-server`. Keep concise user-facing notes under
`[Unreleased]`, including PR links. Preserve previously published entries.
Use Added, Changed, Fixed, Removed, or Breaking Changes only when needed.

```sh
env -u NODE_ENV npm run release:prepare -- patch --dry-run
env -u NODE_ENV npm run release:prepare -- patch
```

An explicit stable `X.Y.Z`, `minor`, or `major` is also accepted. Preparation
synchronizes `package.json` and both root lockfile versions, dates the release
entry in UTC, and opens a fresh Unreleased section. It does not commit, tag,
push, or publish. Review the diff and merge it through the normal PR process.
Versions must not go backwards or reuse an existing release. Prerelease
versions are not supported. Empty notes are rejected.

`npm run check:version` validates version consistency; use
`npm run version:set -- X.Y.Z` for manual synchronization. If preparation
fails after writing files, inspect and finish or restore those specific changes
before retrying.

## Validate

Validate the selected candidate with locked dependencies and `NODE_ENV` unset:

```sh
env -u NODE_ENV npm ci
env -u NODE_ENV npm run check
env -u NODE_ENV npm run build
env -u NODE_ENV npm audit
env -u NODE_ENV npm audit --omit=dev
git diff --check
```

The check includes version validation, TypeScript, application tests, and
release-helper tests. Tests use deterministic CPU workers and need audio-capable
ffmpeg; when it is not at `/usr/bin/ffmpeg`, set `OPENAI_SPEECH_FFMPEG` to its
absolute path. Release-helper tests use disposable Git repositories and a fake
GitHub CLI; run them separately with `npm run test:release` when changing helpers.

Record the source revision, commands, platform, results, and limitations in the
release PR. Confirm example configuration and operator docs match the release.
Review dependency findings and update affected packages or record their impact
and disposition before publication; an audit result is time-sensitive.
Real model/GPU inference, Sedes client integration, and deployment smoke tests
are separate gates: record which were run and which remain unverified. For an
explicitly selected running deployment, use `npm run smoke` with
`OPENAI_SPEECH_SERVER_URL` and `OPENAI_SPEECH_SERVER_TOKEN`. Do not start or
modify a deployment merely to publish a source release.

## Publish

After review and merge, when publication is requested:

```sh
git switch main
git fetch origin
git merge --ff-only origin/main
env -u NODE_ENV npm run release:publish -- X.Y.Z --dry-run
env -u NODE_ENV npm run release:publish -- X.Y.Z
```

Replace `X.Y.Z` with the prepared version. Publication requires authenticated
`gh`, clean `main` matching the live remote, synchronized package versions,
and a matching latest dated changelog entry. It creates an annotated tag at
that exact commit, pushes only that tag, and creates the GitHub release from
the changelog notes. It does not run tests, certify readiness, or push branch
changes. Both dry runs read remote state without changing files or publishing.

If publication fails after tagging or pushing, retry at the same commit.
Matching tags and releases are reused; conflicting tags, titles, notes, drafts,
or prerelease status are refused. API errors stop publication. If main moved
after partial publication, inspect the existing tag and release before recovery;
never move a published tag. Verify the remote tag targets the intended commit
and the GitHub release contains the reviewed notes.
