# COORD desktop

A native Electron app for project pairing, teammate discovery, explicit file sharing, and Codex/Claude connections. It includes its own Node runtime; recipients do not need Node, pnpm, a terminal, or Git to exchange files.

## Development

From the repository root:

```sh
pnpm install
pnpm --filter @coord/desktop build
pnpm --filter @coord/desktop start
```

The build targets `https://coord-team.waledblack14.chatgpt.site`. Set `COORD_PORTAL_URL` during the build to use another HTTPS portal or a local development endpoint. This address is compiled into the app; the renderer cannot change it.

## Build the Mac download

```sh
pnpm --filter @coord/desktop package
```

Outputs appear in `dist/desktop-release/`: a real `COORD.app`, ZIP, and drag-to-Applications DMG. The current native build targets Apple Silicon on macOS 13 or later. The Electron runtime and native peer-network libraries are included. Builds use an explicit ad-hoc signature and are **not notarized**. Normal trusted public distribution requires a Developer ID Application certificate and Apple notarization credentials; use electron-builder's signing configuration in the release environment. Do not ask recipients to disable macOS security.

The source icon is reproducible using `node --import tsx apps/desktop/scripts/icon.ts` on macOS. It creates the PNG and ICNS under `assets/`.

## Security boundaries

The renderer loads only packaged local assets, uses a restrictive content security policy, runs sandboxed with context isolation, and has no Node integration. The preload exposes a fixed action list. The main process verifies each IPC request comes from the exact local main frame. Folder and file paths come from native selection dialogs. Incoming files remain in an isolated review folder, with an explicit button to open that folder. No received file is executed or automatically applied.

System keychain encryption protects the device credentials. Only the configured website origin can open through the app. Public Internet transfers attempt direct peer networking and can fall back to an encrypted relay; the received-file panel reports the route. The local MCP bridge keeps the website credential in the desktop process; installed agents use a private local bridge file and the app's bundled runtime. COORD must remain running for those agent connections.
