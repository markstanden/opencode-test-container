# Release 0.1.0

Published 2026-11-15. This is the first public release of
`@markstanden/opencode-test-container`.

## Source provenance

| Fact               | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| Pull request       | [#1](https://github.com/markstanden/opencode-test-container/pull/1) |
| Merged head        | `287e30a236e34b0dda8a24d966d7c3d6140d0c1b`                          |
| Merge commit       | `f56092f514c2f3c5055042582adf336090630757`                          |
| Registry `gitHead` | `f56092f514c2f3c5055042582adf336090630757`                          |
| Merge method       | squash                                                              |
| Merge gate         | Defined Gate green on the merged head and on `main` after merge     |

The release was built from the clean merged `main` at the merge commit above.
`npm ci` and `defined comply` passed before packing.

## Artifact identity

| Fact                  | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Package               | `@markstanden/opencode-test-container`                                                                |
| Version               | `0.1.0`                                                                                               |
| Tarball               | `markstanden-opencode-test-container-0.1.0.tgz`                                                       |
| Local tarball SHA-256 | `a3731bb52bc154173bb6103a2e175b5a9fc19b3b8ca9bf90e2e07fb12495015b`                                    |
| Registry shasum       | `c336020f78aa49953964692020a9be2497c19885`                                                            |
| Registry integrity    | `sha512-5dhOJwj4UgxLnOdLoW/gMeLnJ2lU0A8aDj2h5cIwo/iV5hULvrLogE6Ihjom07TzenE/ZOJZ6WPfzqx3iulXZg==`     |
| Registry tarball      | <https://registry.npmjs.org/@markstanden/opencode-test-container/-/opencode-test-container-0.1.0.tgz> |
| Files / unpacked size | 121 / 942,231 bytes                                                                                   |
| Published             | `2026-11-15T14:13:49.115Z`                                                                            |

The local tarball and registry artefact carry the same shasum and integrity;
the registry reports the merge commit as `gitHead`.

## Verification

- Covered by `defined comply` at the merge commit: typecheck, ordinary tests,
  coverage floors and the packaged-CLI proof.
- Registry signatures are present for the npm signing key
  `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`.
- No npm provenance attestation was generated: publication was a local
  `npm publish`, not a supported CI OIDC publish. The merge commit, tarball
  SHA-256, registry integrity and registry signatures above are the available
  provenance evidence.

## Notes

- `0.1.0` is the `latest` dist-tag.
- The registry also lists an earlier `0.0.0-stage` version; it is not this
  release and carries no OTC support claim.
