# COORD early testing: Vercel website and persistent hub

The website and the collaboration hub are separate deployments. Vercel serves the account/project website and its account API. Supabase Auth handles sign-in; Supabase PostgreSQL stores projects, membership, invitations, and device approvals. A continuously running Linux hub stores shared source and file reservations. Keeping that hub online lets teammates continue after the project creator closes their laptop.

This document is a deployment runbook. It does not establish that a hub, a configured Vercel deployment, or an updated desktop download is already live.

## What testers should do

After the operator completes the setup below:

1. Open the COORD website and create an account or sign in.
2. Create a project, generate a membership invitation, and share that one-use key privately with a teammate.
3. Download the desktop build linked by that website, install it, and sign in with the same account.
4. Select the project and choose a local folder in the native picker. Follow the app's guidance about importing an existing project versus receiving a shared copy.
5. The teammate creates or signs into their own account, accepts the membership invitation, and connects a folder on their own computer.
6. Start new trusted Codex or Claude sessions after the app installs project integration. Keep COORD running while using the local agent bridge.

Testers should not need Node, Docker, a database, admin credentials, manually entered IP addresses, or terminal commands. The operator handles infrastructure. An older desktop download from before the account feature will not gain sign-in by changing the website alone.

## Why the hub runs separately

The repository's hub is a long-running Node process with a stable peer identity, HyperDHT UDP sockets, a durable SQLite registry, and a private source directory. The Vercel deployment in this repository only uses static assets and request-scoped account functions. Moving `apps/hub/main.ts` into a Vercel API handler would not preserve that lifecycle or provide its persistent private disk.

Vercel documents bounded Function execution and automatic concurrency scaling. Those properties are incompatible with using this particular singleton process as an always-running authority inside a request handler; this is an architectural conclusion about COORD's implementation, not a claim that Vercel has no other backend products. [Vercel Function limits](https://vercel.com/docs/functions/limitations)

Source synchronization continues over authenticated peer connections to the hub. Account HTTPS is not a file-transfer relay. Restrictive networks that block the peer transport can still prevent synchronization even when website sign-in succeeds.

## Deploy the Linux hub

Use the instructions in [the hub deployment guide](../distribution/hub/README.md), with Node 24 or the provided Docker/Compose setup. Required deployment properties:

- A persistent private disk for the entire hub data directory, including SQLite, source, and peer identities.
- One hub process per data directory. The SQLite singleton lock prevents independent authorities from granting conflicting ownership against the same files.
- Working UDP networking for HyperDHT, plus an HTTPS hostname reachable from Vercel for account requests.
- A process supervisor or the Compose restart policy, so closing an administrator's terminal does not stop the hub.

Keep the hub's HTTP listener on loopback and put the supplied Caddy HTTPS proxy in front of it. Configure DNS and certificates for a hostname you control. The default private port is `127.0.0.1:4200`; do not expose that plaintext port publicly.

In the hub's private environment file, configure:

```dotenv
COORD_HUB_ADMIN_TOKEN=REPLACE_WITH_RANDOM_64_HEX_CHARACTERS
COORD_PORTAL_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_64_HEX_SECRET
COORD_HUB_DATA=/path/to/private/coord-hub-data
COORD_HUB_HOST=127.0.0.1
COORD_HUB_PORT=4200
COORD_HUB_DOMAIN=hub.example.com
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=REPLACE_WITH_YOUR_SERVER_SECRET
```

These are placeholders, not usable credentials. Generate independent random secrets; keep the real file outside Git and readable only by the service owner. `COORD_HUB_ADMIN_TOKEN` is for private operator administration. `COORD_PORTAL_TOKEN` authenticates the website backend to the hub's device-connection endpoint. The two credentials have different roles and must not be distributed to testers or embedded in desktop JavaScript.

The hub can read canonical source to validate and publish changes. Encrypting transport does not hide files from the operator of that hub. Use a trusted host and protect disk access and backups.

## Configure Vercel

Import the repository using its root directory, so the root `vercel.json` and account function are included. The current configuration uses framework “Other”, `node scripts/build-web.mjs`, output `dist/web`, and the account function `api/account.ts`. The explicit `/api/account/:route*` rewrite is required for nested pairing and project routes; the bare Node runtime does not use Next.js catch-all file routing. Keep the checked-in configuration as the source of truth; remove stale dashboard build/output overrides from earlier deployment attempts if they contradict it. Do not select `apps/portal`, the old Sites project, or the Electron app directory as the root for this standalone Vercel website. [Vercel project configuration](https://vercel.com/docs/project-configuration)

First apply the SQL and configure Supabase Auth as described in [the Supabase setup guide](../supabase/README.md). Set these **server-side** environment variables in the intended Vercel environment:

- `SUPABASE_URL`: your Supabase project origin.
- `SUPABASE_PUBLISHABLE_KEY`: the project publishable key.
- `SUPABASE_SECRET_KEY`: the privileged server key, kept out of browser and desktop bundles.
- `COORD_WEBSITE_URL`: the exact HTTPS production website origin.
- `COORD_GOOGLE_ENABLED`: `1` only after the Google OAuth provider is configured in Supabase.

- `COORD_HUB_URL`: the hub's HTTPS origin, such as `https://hub.example.com`, without credentials, query parameters, or a path.
- `COORD_PORTAL_TOKEN`: exactly the same portal secret configured on the hub.

Do not put either secret in a public-prefixed variable, static HTML, browser bundle, desktop build, repository file, or URL. The admin token is not needed by Vercel. Use a separate test hub and credentials for preview deployments if previews should not access production accounts and projects.

Deploy again after setting or changing environment variables. Vercel applies changed variables to new deployments rather than retroactively changing previous deployments. [Vercel environment variables](https://vercel.com/docs/environment-variables)

Registration, sign-in, projects, invitations, and desktop pairing use Supabase through `/api/account` and can work before a hub is deployed. Connecting a desktop folder to a cloud project still needs `COORD_HUB_URL` and `COORD_PORTAL_TOKEN`. The website displays this distinction. Without `SUPABASE_URL`, the API retains its legacy hub account proxy for existing installations.

## Publish the matching desktop build

Build the account-enabled app with the intended production portal origin, and point the website's download link to that exact release artifact. Verify the packaged app, not just a browser preview of its renderer. Keep the website and app versions compatible with the same hub account API.

Mac release signing and notarization require the owner's Apple Developer credentials. No such credentials are supplied by these source changes. Until a release is signed and notarized, describe it as an unsigned/ad-hoc early-testing build and verify the normal supported installation experience on a second Mac. Do not ask testers to disable macOS security protections. Do not advertise Intel Mac or Windows downloads unless those specific artifacts have been built and tested.

## Verify before inviting testers

Use two accounts and two physical computers on different networks:

1. Register and sign in; confirm an incorrect password is rejected without disclosing which part was wrong.
2. Create a project with the first account. Confirm the second account cannot access it before accepting its invitation.
3. Give the second account a one-use membership key, accept it while signed in, and connect both desktop apps. Confirm a connection approval is bound to the signed-in device's peer identity.
4. Publish a small safe source file. Confirm the other device receives the same content, and conflicting reservations prevent overlapping publication.
5. Close the creator's app. Confirm the other member can still read, reserve, and publish through the hub.
6. Restart the hub while preserving its disk. Confirm saved projects and approved devices reconnect, and reacquire any expired reservations.
7. Remove a member or revoke a device. Confirm it cannot reconnect using an outstanding invitation or keep publishing with its previous approval.
8. Download the advertised desktop artifact from the website on a clean machine and complete sign-in/folder selection without developer tooling.

These checks are acceptance criteria, not claims that physical-device validation or production deployment has already occurred.

## Diagnose common setup failures

- **Website loads, account actions fail:** confirm the current deployment has the Supabase variables, the SQL migration is applied, and the project is available. Check `/api/account/config` for the selected backend mode.
- **A Vercel login page appears inside an API response:** deployment protection may be intercepting requests from the desktop app. Configure access for the intended tester deployment; do not put a deployment-bypass secret in the app.
- **Sign-in works, project connection stays offline:** inspect hub health and peer networking. Confirm the hub has the matching Supabase configuration and portal token. Account HTTPS cannot fix a blocked UDP connection.
- **Project disappears after redeployment:** inspect the persistent hub volume and service identity. Rebuilding the website should not recreate the hub data directory.
- **An old app has no account screen:** publish and link the matching account-enabled desktop build.

Back up the entire stopped hub data directory and test restoring it before relying on early-test projects. Never run an original and restored copy of the same hub identity at the same time.
