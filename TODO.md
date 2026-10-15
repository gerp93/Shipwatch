# TODO

This plugin's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and this repo's `REPO_SCOPE.md` entry for that). Just what's not built yet.

## Features

-

## Fixes

-

## Standalone app (app/)

Brought up to the KVG standard for an Electron app in this change: logo and icons, VisualAssault themes (pinned
to a tag), `electron-updater`, and the shared release wiring. Still to do:

- Refresh on a timer or from a tray, OS notifications, and keeping the report's filters across a refresh.
- Needs real-world verification: the installers and the self-update have not run yet (the first release that
  includes `app/` is their first real test); check the installer icon, an in-place update from one release to the
  next, and `perUser` vs `perMachine` install behaviour on Windows.
- The logo was supplied as a JPEG with a checkerboard baked in, so `assets/logo.png` is a colour-keyed cut-out
  with some faint residue at its edges. Replace it with a true transparent PNG when there is one, then run
  `npm run icons` in `app/`.
