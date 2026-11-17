# Releasing

Publication runs from `.github/workflows/npm--publish.yml` using npm trusted
publishing (GitHub OIDC). A release tag is the publish switch: there is no
local `npm publish` step and no `NPM_TOKEN`.

## One-time npm setup

Configure the package's trusted publisher on npmjs.com (package Settings →
Trusted Publisher → GitHub Actions). The provider and required fields cannot be
edited later; a mistake means deleting the connection and creating another.

| Field             | Value                     |
| ----------------- | ------------------------- |
| Organization/user | `markstanden`             |
| Repository        | `opencode-test-container` |
| Workflow filename | `npm--publish.yml`        |
| Environment name  | `npm-publish`             |

Two settings decide whether the first release works at all:

- **Allowed actions must include `npm publish`.** The browser form offers
  `npm publish`, `npm stage publish` and `npm dist-tag`, with at least one
  required. The workflow runs plain `npm publish`, so tick that box; dist-tag
  is not needed.
- **`package.json` `repository.url` must match the GitHub repository.** If it
  does not, npm refuses the OIDC publish.

The connection expires if it is not validated: create it immediately before
the release tag, not weeks ahead, and finish the first publish within two days.

Also configure:

- Repository settings → Environments → `npm-publish`, with required reviewers
  if the release should wait for a human. The environment name here and in the
  npm form must be identical; a mismatch fails at publish time, not on save.
- Package Settings → Publishing access → _Require two-factor authentication and
  disallow bypass 2FA tokens_, once a release has published over OIDC. Trusted
  publishers keep working; token-based publishing stops.

## Release steps

1. Bump `version` in `package.json` and in `package-lock.json` (both the
   top-level and `packages[""]` entries), merge to `main`, and let the Defined
   Gate go green.
2. Tag the merge commit — not the branch head you happen to have:

    ```sh
    git tag -a v0.1.1 -m "0.1.1" <merge-commit>
    git push origin v0.1.1   # this is the publish
    ```

3. Approve the `npm-publish` environment deployment in the run.
4. Verify the artefact (below).

`workflow_dispatch` re-runs the same job against a tag chosen in the ref
selector; it refuses a branch ref.

## What the workflow refuses

- Any ref that is not a `v*` tag.
- A tag that is not `v<package.json version>`.
- A tag whose commit is not an ancestor of `main`, so only gated, merged
  commits ship.
- A tree that fails `defined verify` in the pinned gate image. `comply` is
  deliberately not used: it repairs files, and the tarball must be the tagged
  source.

The tag itself is immutable: a repository ruleset on `refs/tags/v*` blocks
deletion and force-pushes for everyone, with no bypass actors. It does not
restrict creating a new tag, so `git push origin v0.1.2` still works — and a
fresh tag with the wrong version still fails the version guard inside the
workflow.

`npm publish` builds `dist` through `prepack`, and npm generates the provenance
attestation automatically under OIDC on a public repository.

## Verifying a release

```sh
npm audit signatures
npm view @markstanden/opencode-test-container@0.1.1 dist.attestations
npm view @markstanden/opencode-test-container@0.1.1 gitHead
```

The attestation ties the tarball to this repository, workflow, tag and commit.
`0.1.0` predates trusted publishing and carries no attestation; see
[release-0.1.0.md](release-0.1.0.md).
