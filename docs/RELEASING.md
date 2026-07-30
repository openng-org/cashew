# Releasing `@openng/cashew`

Releases are cut by the [`Release` workflow](../.github/workflows/release.yml) — a manually
dispatched pipeline that versions, builds, tags, publishes to npm with provenance, and creates the
GitHub Release.

> [!IMPORTANT]
> The workflow **cannot succeed until the [one-time setup](#one-time-setup) below is done**. It needs
> a GitHub App that can bypass the `protect-main` ruleset, an npm trusted publisher for the package,
> and the missing `v5.x` tags restored. The first two require repository/organization admin.

## Cutting a release

1. **Actions → Release → Run workflow**, with `main` selected as the branch.
2. Pick a **bump**:
   | Bump | Effect |
   | --- | --- |
   | `auto` (default) | standard-version infers the bump from the conventional commits since the last tag — `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major |
   | `patch` / `minor` / `major` | Force that bump regardless of the commits |
   | `prerelease` | Cut a `-0` prerelease and publish it under the **`next`** dist-tag, so `npm i @openng/cashew` never resolves to it |
3. Leave **dry run** ticked for a rehearsal, or **untick it** for a real release.
4. Watch the run. The step summary reports the version, the bump, and whether it was a dry run.

That's it — there is nothing to do locally. The `npm run release` script still exists for a manual
release, but the workflow is the supported path.

### What the workflow does, in order

```
gate ─ test:lib · test:schematics · build:lib · build      (matrix, fail-fast)
  │
  ▼
release
  1. mint GitHub App token (bypasses protect-main)
  2. checkout with full history + tags   ← standard-version needs them
  3. Node 22, no registry-url            ← OIDC depends on there being no .npmrc
  4. npm ci, then npm i -g npm@latest    ← trusted publishing needs npm >= 11.5.1
  5. standard-version  → bump projects/openng/cashew/package.json,
                         write CHANGELOG.md, commit, tag vX.Y.Z
  6. npm run build:lib → dist/openng/cashew, carrying the new version
  7. git push --follow-tags origin HEAD:main
  8. gh release create vX.Y.Z, notes taken from the new CHANGELOG section
  9. npm publish dist/openng/cashew --access public --tag latest|next
 10. step summary
```

Two ordering properties are deliberate and worth preserving if you edit the workflow:

- **The build runs after the version bump**, so the generated `dist/openng/cashew/package.json`
  carries the released version.
- **`npm publish` runs last.** It is the only irreversible step, so every fallible git operation
  (push to protected `main`, tag push, release creation) has to succeed first. This is what prevents
  an npm-ahead-of-git split-brain where a version exists on the registry but `main` was never
  updated.

On a dry run the manifest and changelog are still written to disk — that is what lets
`npm publish --dry-run` pack a realistic, non-colliding tarball — but nothing is committed, tagged,
pushed, or uploaded.

## One-time setup

### 1. GitHub App for the release commit

`openng-org/cashew` has an active **`protect-main`** ruleset: pushes to `main` must go through a pull
request with one approving review, and there are no bypass actors. The default `GITHUB_TOKEN` is
therefore rejected with `GH006` when the workflow tries to push the `chore(release): X.Y.Z` commit.
A GitHub App added as a bypass actor is the narrowest way around this — it keeps the PR requirement
in force for humans while letting exactly one automated identity push release commits.

1. **Create the app** (org **Settings → Developer settings → GitHub Apps → New GitHub App**).
   Name it something like `openng-release-bot`. Under **Repository permissions** grant
   **Contents: Read and write** and nothing else. No webhook needed.
2. **Generate a private key** and note the **App ID**.
3. **Install the app** on `openng-org/cashew` only.
4. **Add repository secrets** (Settings → Secrets and variables → Actions):
   - `RELEASE_APP_ID` — the App ID
   - `RELEASE_APP_PRIVATE_KEY` — the full contents of the `.pem` file
5. **Add the app as a bypass actor**: Settings → Rules → `protect-main` → **Bypass list** → Add →
   the app. Without this step the workflow fails at _Push commit and tag_.

The workflow requests `permission-contents: write` on the minted token, so the token is scoped down
at dispatch time even if the installation is granted more later. Tokens are short-lived and revoked
when the job ends.

### 2. npm trusted publishing (OIDC)

The workflow publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
no long-lived `NPM_TOKEN` is stored anywhere, and npm attaches a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements) automatically —
no `--provenance` flag required.

**Bootstrap caveat:** `@openng/cashew` does not exist on the registry yet, and a trusted publisher is
configured on an existing package's settings page. So the first publish has to be done by hand:

1. An owner of the npm `@openng` organization runs, from a clean checkout of `main`:
   ```shell
   npm ci
   npm run build:lib
   npm publish dist/openng/cashew --access public
   ```
2. Then on npmjs.com → the package → **Settings → Trusted publishing → GitHub Actions**, with:
   - Organization or user: `openng-org`
   - Repository: `cashew`
   - Workflow filename: `release.yml`
3. From then on every release is fully automated and no token is ever needed.

Two requirements the workflow already handles, but which break silently if someone "tidies" them:

- **npm ≥ 11.5.1** (and Node ≥ 22.14.0). Node 22 ships npm 10.9.x, hence the explicit
  `npm i -g npm@latest` step.
- **No `registry-url` on `actions/setup-node`.** Setting it writes an `.npmrc` containing
  `_authToken=${NODE_AUTH_TOKEN}`; with no token in the environment, `npm publish` then fails
  `ENEEDAUTH` before it ever attempts OIDC.

### 3. Restore the missing `v5.x` tags

**Do this before the first automated release.** The repository's tags stop at `v4.1.0`, but three
5.x releases were cut — the `chore(release)` commits are on `main` and the entries are in
`CHANGELOG.md`, only the tags were never pushed. standard-version derives its commit range from the
last reachable tag, so as things stand `auto` walks all the way back to `v4.1.0`: it proposes
**6.0.0** (picking up `BREAKING CHANGE:` footers that shipped in 5.0.0) and regenerates a changelog
section duplicating everything already recorded for 5.0.0, 5.1.0 and 5.3.0.

Recreate the tags on their release commits and push them:

```shell
git tag v5.0.0 cc781c8   # chore(release): 5.0.0
git tag v5.1.0 ac663d7   # chore(release): 5.1.0
git tag v5.3.0 88a5ce9   # chore(release): 5.3.0
git push origin v5.0.0 v5.1.0 v5.3.0
```

With `v5.3.0` in place, `auto` sees only the commits since it — `feat: add devcontainer setup` and
`feat: add ng add schematic support` — and correctly proposes **5.4.0**. Verify before releasing:

```shell
cd projects/openng/cashew && npx standard-version --infile ../../../CHANGELOG.md --dry-run
```

(If you would rather not rewrite history's tags, the alternative is to dispatch the first release
with an explicit `bump` instead of `auto` and hand-correct `CHANGELOG.md` afterwards. Tagging is
much less work.)

## Testing the workflow

`workflow_dispatch` workflows only become dispatchable once the workflow file exists on the
**default branch**. This is a GitHub limitation, not a bug in the workflow: until `release.yml` is
merged to `main`, it will not appear in the Actions tab and the dry run cannot be exercised — even
though the `gate`/`release` jobs are written to allow dry runs from any branch.

Two ways to rehearse before merging:

- Push the branch to a **fork** and temporarily make it the fork's default branch, then dispatch with
  dry run ticked. The `gate` job and the version/build/pack steps all run; the app-token step will
  fail unless the fork has the secrets, so this mainly validates the gate and the version logic.
- Temporarily add a `push:` trigger for the branch, let it run, then remove it before merging.

Locally you can validate the two parts that carry the most risk:

```shell
# What version would be cut, and what changelog would be written?
cd projects/openng/cashew && npx standard-version --infile ../../../CHANGELOG.md --dry-run

# Is the tarball the workflow would publish correct?
npm run build:lib && npm pack --dry-run ./dist/openng/cashew
```

## If a release fails

- **Failure before `npm publish`** — nothing reached the registry. Fix the cause and re-run. If the
  commit and tag were already pushed, dispatch again with the same explicit bump, or bump manually.
- **Failure at `npm publish`** — `main` and the tag are already updated, so re-running is safe: npm
  rejects a version that already exists, and every step before publish is idempotent.
- **A bad version reached npm** — do not unpublish. Cut a new patch release, and use
  `npm deprecate @openng/cashew@x.y.z "<reason>"` to steer people off it.

## Choosing the release tool

Two workflows are checked in. **`release.yml` (standard-version) is the active one**;
`release-semantic-release.yml` is a dispatch-only alternative that does nothing unless deliberately
run, kept so the two can be compared on real files.

|                  | `release.yml` — standard-version                                                 | `release-semantic-release.yml` — semantic-release  |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Version source   | Conventional commits, **overridable** via the `bump` input                       | Conventional commits, always automatic             |
| Tooling          | `standard-version`, already a devDependency and what wrote the current CHANGELOG | 4 new devDependencies                              |
| Changelog format | Unchanged from the existing `CHANGELOG.md`                                       | Regenerated in semantic-release's format           |
| Publish safety   | git push → GitHub release → npm publish                                          | git push → npm publish → GitHub release            |
| Status           | Reuses tooling this repo already releases with                                   | **Never executed — validate with a dry run first** |
| Caveat           | `standard-version` is deprecated upstream (still functional)                     | Actively maintained                                |

`release-semantic-release.yml` deliberately avoids `@semantic-release/npm`, whose `verifyConditions`
runs before the library is built and would fail on a missing `dist/openng/cashew` package root.
Instead [`.releaserc.json`](../.releaserc.json) drives the bump, the build, and the publish through
`@semantic-release/exec`, so the publish command is identical to the one in `release.yml` and picks
up OIDC the same way. It publishes to the `latest` dist-tag only; prereleases would need a
prerelease branch entry in `branches` and a channel-aware `publishCmd`.

### To switch to semantic-release

```shell
npm i -D semantic-release @semantic-release/changelog @semantic-release/git @semantic-release/exec
git rm .github/workflows/release.yml
git mv .github/workflows/release-semantic-release.yml .github/workflows/release.yml
npm uninstall standard-version   # and drop the root "release" script
```

Then re-point the npm trusted publisher at the new workflow filename if it changed, and update the
`bump`-input references in this document.

## Related

- Issue [openng-org/cashew#2](https://github.com/openng-org/cashew/issues/2) — scope of the first
  `@openng`-scoped release, and where this workflow was requested.
- [jsverse/transloco's `release.yml`](https://github.com/jsverse/transloco/blob/master/.github/workflows/release.yml)
  — the workflow this one is ported from. transloco is an Nx monorepo and drives everything through
  `nx release`; the Nx steps are replaced here by `standard-version`, `gh release create`, and
  `npm publish dist/openng/cashew`.
- [`ci.yml`](../.github/workflows/ci.yml) — the test/build workflow that runs on every push and PR.
  Note it installs with `npm i` while the release path uses `npm ci`.
