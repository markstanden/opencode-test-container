# Release 0.1.1

Published 2026-11-15. This is the first release published by CI over npm
trusted publishing, and the first to carry a provenance attestation.

## Source provenance

| Fact               | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| Pull request       | [#2](https://github.com/markstanden/opencode-test-container/pull/2) |
| Merged head        | `843a45aacfa6e55c0721a972a1808dec707a3dd6`                          |
| Merge commit       | `60acb33ee12d7cfb13ce512d49474edf04b167d7`                          |
| Registry `gitHead` | `60acb33ee12d7cfb13ce512d49474edf04b167d7`                          |
| Merge method       | squash                                                              |
| Publish workflow   | `.github/workflows/npm--publish.yml`, run 43726063672               |
| Trigger            | annotated tag `v0.1.1` on the merge commit                          |
| Merge gate         | Defined Gate green on #2 (twice) and on `main` after merge          |
| Pre-publish verify | `defined verify` in the pinned gate image, inside the publish job   |

Publication was a GitHub Actions OIDC publish from the tag; no `npm publish`
ran on a laptop and no `NPM_TOKEN` exists.

## Artifact identity

| Fact                  | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Package               | `@markstanden/opencode-test-container`                                                                |
| Version               | `0.1.1`                                                                                               |
| Tarball               | `markstanden-opencode-test-container-0.1.1.tgz`                                                       |
| Local tarball SHA-256 | `c0f875d26f9fa1477f89d5604bc215a30a7d026e3e363ae286db8fa14ff3cb14`                                    |
| Registry shasum       | `db2b599c0a63c45d3fa77b556fbf2ba9bebf4b1c`                                                            |
| Registry integrity    | `sha512-kN8FurIRqMEV8VWPMcmIEIXzDDQvstrnIuS3vG6eVvOOzQtThwkd5mD205AKWlrgzP8q5YnBb4h2qVRQrmFDpw==`     |
| Registry tarball      | <https://registry.npmjs.org/@markstanden/opencode-test-container/-/opencode-test-container-0.1.1.tgz> |
| Files / unpacked size | 123 / 948,786 bytes                                                                                   |
| Published             | `2026-11-15T14:47:31.268Z`                                                                            |

`npm pack` at the merge commit reproduces the published tarball exactly — same
sha256, shasum (`db2b599c…`) and integrity — so the registry artefact is a
build of `60acb33` by any measure, not merely by `gitHead`.

`src/` is unchanged from 0.1.0. The tarball gains `docs/releasing.md` and a new
version; nothing else in the shipped tree moved.

## Attestation

| Fact             | Value                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Predicate type   | `https://slsa.dev/provenance/v1`                                                                |
| Attestation      | <https://registry.npmjs.org/-/npm/v1/attestations/@markstanden%2fopencode-test-container@0.1.1> |
| Transparency log | <https://search.sigstore.dev/?logIndex=3904196001>                                              |

`npm audit signatures` in a clean consumer reports one verified registry
signature and one verified attestation for this version.

## Verification

- `defined comply` at the merge commit: typecheck, 581 tests, coverage floors
  and the packaged-CLI proof.
- Tag/version and off-`main` guards exercised before release: the matching tag
  passed; a mismatched version failed; a tag on a commit outside `main` failed.
- Registry signatures remain present for the npm signing key
  `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`.

## Notes

- `0.1.1` is the `latest` dist-tag.
- `0.1.0` predates trusted publishing and carries no attestation; see
  [release-0.1.0.md](release-0.1.0.md). The provenance gap there is now closed
  from 0.1.1 onward, not retroactively.
- The `npm-publish` environment existed but carried no reviewer for this first
  run, so the publish did not pause for approval.
