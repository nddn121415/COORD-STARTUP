# COORD desktop

COORD runs in the menu bar and connects local project folders to a shared coordination service or an approved teammate’s computer. The app bundles its runtime: teammates do not need Node, pnpm, Git, or a terminal.

## Account connection

1. Open COORD and enter your collaboration website’s HTTPS origin.
2. Choose **Sign in through website**. Approve the displayed code in the browser using your website account. The app updates automatically.
3. Choose a project from your account, then select its local folder. The website issues a connection invitation bound to this computer’s public identity.
4. Open a fresh trusted Codex or Claude session in the selected project. COORD installs the project integration automatically; existing sessions may need to reload their MCP configuration.

The browser opens `/connect?code=<userCode>`. Device credentials remain in the native process, encrypted using the OS keychain. The renderer sees the account name, project list, and approval code, never the session token or device polling secret.

Invite-key pairing remains available. Service projects remain available while the service is online. Temporary computer-hosted projects require their host computer to remain online. Selecting an existing folder does not grant permission to overwrite divergent local files.

## Development

```sh
pnpm install
pnpm --filter @coord/desktop build
pnpm --filter @coord/desktop start
```

Set `COORD_WEBSITE_URL` at build time to your stable production HTTPS origin. Without it, users enter their website address. An HTTPS origin override is available in the sign-in screen; HTTP is permitted only for loopback development hosts. No transient preview address is compiled into the default build.

## Build the Mac download

```sh
COORD_WEBSITE_URL=https://your-site.example pnpm --filter @coord/desktop package
```

`dist/desktop-release/` contains `mac-arm64/COORD.app`, a ZIP, and a drag-to-Applications DMG. Builds target Apple Silicon and macOS 13+. Native networking and the MCP executable are included. Local builds are ad-hoc signed, not notarized. Trusted public distribution requires a Developer ID Application certificate and Apple notarization credentials. Do not disable macOS security to distribute the app.

## Coordination boundaries

Each MCP process receives a distinct identity and can create an isolated working directory. Agents reserve files before changing them and submit through ownership and base-version checks. Rejected reservations require working elsewhere, waiting, or releasing ownership. COORD does not inspect private conversations or distinguish internal subagents sharing one MCP process. Arbitrary editor or shell writes outside its tools are not intercepted; divergent local changes are preserved and surfaced for review.

The renderer is sandboxed, has no Node integration, uses a restrictive content security policy, and loads packaged assets only. Main-process IPC validates the exact originating frame. Account requests reject redirects, cap response size, time out, and send credentials only to the selected website origin. Account state is persisted through OS encryption in an owner-only file. The private local MCP bridge does not expose website tokens to agents.
