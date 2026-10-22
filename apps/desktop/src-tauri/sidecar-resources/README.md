# sidecar-resources (build-materialized)

This directory is a Tauri `resources` source. `scripts/build-sea.mjs`
rewrites its contents at every `desktop:sea` / `desktop:build` run:

- **bundled-runtime mode** (the current fallback — see docs/desktop.md §SEA):
  `wudao-server.cjs` (the self-contained server bundle) + `web/` (the built
  web UI). The desktop shell detects `wudao-server.cjs` here and spawns
  `<node runtime> wudao-server.cjs` with `WUDAO_UI_STATIC_DIR=web/`.
- **SEA / node --compile modes**: emptied (the sidecar is a single
  self-contained executable; nothing extra ships).

Only this README is committed; everything else is generated.
