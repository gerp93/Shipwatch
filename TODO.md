# TODO

This plugin's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and this repo's `REPO_SCOPE.md` entry for that). Just what's not built yet.

## Features

-

## Fixes

-

## Standalone app (app/): not done yet

The app runs and shows the report, but is not yet to the KVG standard for an Electron app:

- Logo and icons: `assets/logo.png`, generated icon sizes, the window and installer icon.
- Theming from VisualAssault, pinned to a tag (the report page has its own CSS for now).
- Update check with `electron-updater`.
- Release wiring: the `*-plugin-app.yml` templates from KVG_Standards (blocked on the shared-workflow PR being merged).
- Refresh on a timer or tray, OS notifications, and keeping the report's filters across a refresh.
