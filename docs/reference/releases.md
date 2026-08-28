# Versioning and releases

This project uses [semantic versioning](https://semver.org/) with automated releases powered by [release-please](https://github.com/googleapis/release-please).

## How it works

1. All commits to `main` must follow [Conventional Commits](https://www.conventionalcommits.org/) format (enforced by commitlint)
2. When commits land on `main`, release-please automatically opens (or updates) a release PR with the proposed version bump and changelog
3. A maintainer reviews and merges the release PR — this is the only manual step
4. Merging the release PR automatically:
   - Creates a git tag (e.g., `v1.2.3`)
   - Publishes a GitHub Release with changelog notes
   - Builds and pushes Docker images with semver tags

## Docker image tags

| Tag | Example | When to use |
| --- | --- | --- |
| `X.Y.Z` | `1.2.3` | Pin to an exact version for reproducible builds |
| `X.Y` | `1.2` | Track patch releases within a minor version |
| `X` | `1` | Track minor + patch releases within a major version |
| `latest` | — | Always points to the most recent release |
| `sha-<short>` | `sha-abc1234` | Every push to `main`; useful for testing unreleased changes |

```bash
# Pin to exact version (recommended for CI/CD)
docker pull ghcr.io/gauthamchandra/kinglet:1.2.3

# Track latest within major version
docker pull ghcr.io/gauthamchandra/kinglet:1
```

## Commit message format

The version bump is determined by commit prefixes:

| Prefix | Version bump | Example |
| --- | --- | --- |
| `feat:` | Minor (`1.0.0` → `1.1.0`) | `feat: add Pub/Sub topic support` |
| `fix:` | Patch (`1.0.0` → `1.0.1`) | `fix: correct scheduler cron parsing` |
| `feat!:` or `BREAKING CHANGE:` | Major (`1.0.0` → `2.0.0`) | `feat!: change default storage mode` |
| `chore:`, `docs:`, `ci:`, etc. | No release | `chore: update dependencies` |

## Changelog

Release notes are maintained in [CHANGELOG.md](../../CHANGELOG.md) at the repository root.

## Creating a release (maintainers)

No manual steps are needed beyond merging the release PR that release-please opens. If you need to force a specific version, you can edit the release PR's `version` field in `package.json` before merging.
