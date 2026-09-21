# COORD early testing: Vercel and Supabase

Account projects use ordinary HTTPS between the native desktop app and the Vercel account API. Supabase PostgreSQL persists shared source, file reservations and agent activity alongside accounts and membership. The creator's laptop can go offline. No Linux hub, UDP setup, IP address entry, Git pushes or locally installed Node is needed for this mode.

## Operator setup

1. Apply both SQL migrations in [supabase/migrations](../supabase/migrations), in order. Each migration runs atomically. Keep the database's RLS and service-only RPC grants intact.
2. Configure Supabase Auth: the production website origin is the Site URL; allow its `/api/account/callback` and `/api/account/callback?state=*` redirects. Configure Google OAuth or a production SMTP provider before inviting arbitrary users. Supabase's default email sender is restricted; a working database does not prove email delivery or Google login is configured.
3. Import the repository root into Vercel. Use the checked-in `vercel.json`, framework Other, build `node scripts/build-web.mjs`, output `dist/web`. Keep the explicit rewrite to `api/account.ts`; nested account routes depend on it.
4. Configure server-side variables:

   ```dotenv
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
   SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET
   COORD_WEBSITE_URL=https://YOUR_PRODUCTION_WEBSITE
   COORD_STORAGE_MODE=supabase
   COORD_GOOGLE_ENABLED=0
   ```

   Set `COORD_GOOGLE_ENABLED=1` only after configuring Google's provider in Supabase. Keep `SUPABASE_SECRET_KEY` secret and out of browser/desktop bundles, Git and URLs. The HTTPS mode does not use `COORD_HUB_URL` or `COORD_PORTAL_TOKEN`.

5. Deploy after changing variables. `/api/account/config` should return `mode:supabase`, `syncTransport:https`, `hubConfigured:true`; the compatibility flag means a collaboration backend is configured. It does not test OAuth or the database schema.
6. Publish desktop 0.8 or later using the desktop release workflow and link that release on the website. Older apps receive an explicit update message when connecting an HTTPS project.

[Vercel configuration](https://vercel.com/docs/project-configuration) and [environment variables](https://vercel.com/docs/environment-variables) describe deployment settings. Source is stored in the selected Supabase project and is readable by its operator; this is not end-to-end encrypted storage.

## What testers do

1. Sign in on the website, create a project and privately send a one-use membership invitation to a teammate.
2. Download COORD, open it, click **Sign in through website** and approve its displayed code in the browser.
3. Choose the project and a local folder. The first contributor can select existing source; a teammate can select an empty folder to receive it.
4. The teammate signs in with their own account, accepts the invitation, connects their desktop and chooses their folder.
5. Keep COORD running in the menu bar. It checks for changes every few seconds. New Codex/Claude sessions use the installed project tools after normal trust/reload steps. Each managed agent gets its own working copy and must reserve files before publishing.
6. Close the creator's app and confirm the teammate can continue. Reopen the creator's app and confirm it catches up.

Test on disposable source first. Early access supports UTF-8 text only, 1 MiB/file, 500 files/16 MiB per project, and 50 files per managed publication. Secrets, private configuration and generated files are excluded. Offline edits remain local until connection returns. Competing changes are preserved for review instead of silently overwriting them. Arbitrary editors can still write locally outside the managed agent tools.

## Release acceptance

Use two accounts on two physical computers, ideally on different networks. Verify real login, invitation acceptance, desktop pairing, bidirectional file creation/edit/deletion, competing reservations, offline drafts, creator-offline operation and device/member revocation. Download the actual advertised artifact onto the second Mac. Passing local HTTP/PostgreSQL integration tests alone does not establish these physical-device or provider-login results.

The current Mac package is ad-hoc signed and not notarized. A broad public beta needs Apple Developer signing/notarization and a clean-machine installation check. Do not tell testers to disable macOS protections. Only Apple silicon/macOS 13+ is currently packaged.

## Troubleshooting

- **Login fails:** check Supabase provider configuration, Google credentials or SMTP, and exact callback URLs. Email confirmation remains required.
- **Project connection asks for an update:** install COORD 0.8 or later.
- **Files stop syncing:** inspect the app's error. Confirm both migrations and `COORD_STORAGE_MODE=supabase`; check project membership/device approval and Supabase availability. Local drafts are preserved.
- **API responds with a Vercel login page:** the deployment is protected. Use the intended production website, without embedding a protection bypass secret in the desktop app.
- **Conflicting local files:** review the listed paths before publishing. No change to another editor can be prevented unless it participates in COORD's reservations.
- **Limits reached:** this beta intentionally caps storage and publication size; do not remove limits without adding appropriate capacity and abuse controls.

The legacy Linux hub remains documented in [distribution/hub/README.md](../distribution/hub/README.md). It is optional for new Supabase HTTPS projects. Existing temporary computer-key projects still need their host online.
