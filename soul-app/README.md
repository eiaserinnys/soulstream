# Soul app

The iOS app lives in `soulstream/soul-app/`. It was imported from
`eiaserinnys/soulstream-dashboard-ios` main at
`a3aad9e041602e8a3ca092cc8854164824a96648`. The original repository is preserved.

## Install and validate

This app uses its own npm dependency tree and `package-lock.json`. It is not a
pnpm workspace package. From the repository root:

```bash
NODE_ENV=development npm --prefix soul-app ci --include=dev
bash -c 'cd soul-app && npx --no-install tsc --noEmit'
npm --prefix soul-app test -- --maxWorkers=2 --testTimeout=60000
```

Native plugins resolve React Native and ExtensionStorage from
`soul-app/node_modules/`; do not link the repository root's dependencies here.
The app's GitHub validation job uses npm independently of the web workspace.

## iOS build and submission

Run EAS from the app directory, with `eas.json` beside `app.json`:

```bash
bash -c 'cd soul-app && npx eas-cli build --platform ios --profile production --non-interactive --auto-submit --message "<release description>"'
```

Production EAS is the build authority. `cli.appVersionSource: remote` and
`build.production.autoIncrement: true` manage the build number. Do not bump or
commit the local `app.json` build number for a release. A Git push alone does not
start this command.

The repository root `.easignore` limits EAS's Git-root archive to `soul-app/`,
including assets, config plugins, local native modules and widget targets. It
excludes dependencies, generated native projects, build output, environment
files and signing credentials. EAS installs npm dependencies and generates
the native project in the app directory.

The Expo project, bundle ID, App Store Connect app, team, URL scheme, App Group
and OAuth client are unchanged. Any EAS GitHub connection must target this
repository and use `soul-app` as its app/base directory. Verify the connection
and project-scoped environment configuration before the next release.

## Codemagic reference

`codemagic.yaml` remains an unverified alternative reference inside this
directory, outside Codemagic's repository-root discovery location. It has no
automatic push trigger and uses `soul-app` as its working directory. Signing,
submission and build-number coordination must be explicitly verified before
it is enabled. Production releases continue through EAS.
