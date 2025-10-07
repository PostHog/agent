# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage package versions and changelog entries.

## Usage

- `pnpm changeset` – create a new changeset describing the changes since the last release.
- `pnpm version-packages` – apply pending changesets and update package versions.
- `pnpm release` – publish the updated packages to npm.

The GitHub Actions workflow automates `version-packages` and `release` when changesets are merged into `main`.

