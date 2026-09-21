# COORD always-on hub deployment

These files prepare an always-on Linux server. Nothing is provisioned or published by adding them. For the account-enabled early-testing website, follow [the Vercel setup guide](../../docs/vercel-early-testing.md) as well.

The hub becomes the project authority: it stores the canonical shared source, approves connection keys, tracks file reservations, and accepts guarded changes. The person who created a project can close their laptop while other members keep working, provided the hub remains online. Desktop clients still need an active network connection for shared publication; isolated edits remain local while disconnected.

## Before deployment

Use one Linux host with Node 24, or Docker Engine and the Compose plugin. Keep a persistent private disk for the hub. Run **one hub process per data directory**; replicas sharing the SQLite files or source directory are unsupported. The container uses Linux host networking because HyperDHT allocates dynamic UDP sockets. Do not substitute ordinary TCP-only hosting or assume Docker Desktop has identical networking.

The administration HTTP API listens on `127.0.0.1:4200` by default. You can administer it over an SSH tunnel without publishing any HTTP endpoint. Peer connections use HyperDHT and require working UDP networking; restrictive firewalls/NAT can prevent connections. The optional HTTPS endpoint below protects the administration API; it is **not** a fallback relay for blocked peer traffic. Test with two actual client networks before opening access to teammates.

## Build and start when ready

From the repository root, copy `distribution/hub/hub.env.example` to a private environment file outside the repository. Generate a token and paste it into `COORD_HUB_ADMIN_TOKEN`:

```sh
pnpm exec tsx scripts/hub-admin.ts generate-token
chmod 600 /path/to/private/hub.env
docker compose --env-file /path/to/private/hub.env -f compose.hub.yaml build hub
docker compose --env-file /path/to/private/hub.env -f compose.hub.yaml up -d hub
```

The token-generation command deliberately prints a new administration secret once. Do not paste it into messages, commit it, or put it into shell command arguments. Other commands read credentials from environment variables. A stolen administration token can create projects and invite or revoke members.

The named volume `coord_hub_data` holds the SQLite registry, persistent peer identity, and shared source. `docker compose down` preserves named volumes; **do not use `down -v`** unless intentionally deleting the hub's state. Health is available at `http://127.0.0.1:4200/healthz` without authentication.

## Run directly with Node 24 instead of Docker

Install Node 24 and pnpm 11.19.0 on your chosen Linux host. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Put the following values in a private environment file outside the repository. Use the token generated above (64 hexadecimal characters):

```dotenv
COORD_HUB_ADMIN_TOKEN=YOUR_GENERATED_TOKEN
COORD_HUB_DATA=/path/to/private/coord-hub-data
COORD_HUB_HOST=127.0.0.1
COORD_HUB_PORT=4200
```

Protect the environment file with mode `600`; create the data directory with mode `700`, owned by the account running the hub. Start from the repository root:

```sh
node --env-file=/path/to/private/hub.env dist/hub.js
```

Keep the full `dist` directory and installed dependencies together: the hub bundle imports shared generated chunks. For unattended operation, configure your host's process supervisor to run this command under a dedicated account and restart it after failures or reboot. An interactive terminal alone does not provide always-on service. Do not run the native process and Docker hub against the same directory simultaneously.

## Private operator administration

Load `COORD_HUB_ADMIN_TOKEN` into your administration shell from your secret manager or private environment file. Set `COORD_HUB_URL` to the loopback address or your HTTPS origin.

```sh
pnpm exec tsx scripts/hub-admin.ts create "My project"
pnpm exec tsx scripts/hub-admin.ts list
pnpm exec tsx scripts/hub-admin.ts invite PROJECT_ID
```

The invite command prints a connection key. Share that key only with the intended teammate. Each person opens COORD, joins with the key, and chooses their local folder. Use a separate invitation for each person. Only one unused invitation is active per project: wait for one person to connect before generating the next key. Generating another invitation replaces the previous unused key. Do not distribute the administration token. Remove access with:

```sh
pnpm exec tsx scripts/hub-admin.ts revoke PROJECT_ID PEER_ID
```

The API client's failure output omits response bodies and bearer credentials. Connection keys and project metadata intentionally appear in successful command output; treat captured terminal output accordingly.

For remote administration without a public API, forward your server's loopback port using SSH:

```sh
ssh -L 4200:127.0.0.1:4200 your-server
```

Keep the tunnel open and run the administration commands locally with `COORD_HUB_URL=http://127.0.0.1:4200`.

## Optional HTTPS administration

When you later choose to publish this endpoint, point a hostname you control at the server, allow inbound TCP 80/443, and set `COORD_HUB_DOMAIN` in the private environment file. Then enable the `https` Compose profile:

```sh
docker compose --env-file /path/to/private/hub.env -f compose.hub.yaml --profile https up -d
```

Caddy obtains and renews TLS certificates. Keep port 4200 bound to loopback. Set `COORD_HUB_URL=https://your-hostname` for administration. The API requires bearer authentication for all `/v1` routes and does not accept browser-origin administration. The legacy `/v1` operator workflow does not require website accounts. The account-enabled website uses a separate server-side `COORD_PORTAL_TOKEN` and the hub account API; configure the same portal token on the hub and Vercel, and expose the hub through HTTPS. Never give the website the administration token.

## Website accounts and the tester experience

For the new website flow, set `COORD_PORTAL_TOKEN` to a separate random 64-hex-character value in the private hub environment file. Set that same secret and `COORD_HUB_URL=https://your-hub-hostname` in Vercel, then redeploy the website. Confirm Compose passes the portal token into the hub container. The website serves account/project actions; the continuously running hub remains responsible for peer identities, memberships, reservations, and canonical source.

Testers create or sign into their own account, share and accept one-use membership invitations, download the matching desktop build, and choose a local project folder. They do not use the operator commands above or receive either service secret. See [Vercel early-testing setup](../../docs/vercel-early-testing.md) for the deployment sequence, download/signing boundary, and two-computer acceptance checks.

## Data and recovery

Peer traffic is encrypted in transit, but the hub must read source to validate reservations and maintain the shared project. This is **not end-to-end encryption hiding files from the server operator**. The selected project source and registry are stored in the private volume. Use a host you trust, restrict disk access, and encrypt disks/backups as appropriate.

For a consistent backup, stop the hub, back up the **entire** data volume (registry, source, and peer identity together), then restart it. Store backups separately with restricted access. Test a restore into a stopped replacement hub before depending on the backup. Never run the original and restored identity simultaneously. Restoring only SQLite or only source can break consistency.

After a restart, verify health, list the saved projects, and reconnect a client before doing new work. Clients may need to reacquire expired reservations. Keep the data directory intact across upgrades. Losing it can lose both project state and peer identity. Use application logs for startup failures; do not enable logs that record administration headers or invitation keys.

## Validation boundary

Run the local automated tests for registry restart and authenticated administration behavior before deploying. The Docker/HTTPS deployment requires an actual Linux host and domain to validate; this preparation does not establish a deployed service or prove connectivity through every client network.
