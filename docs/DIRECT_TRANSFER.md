# Direct computer-to-computer file transfer

COORD now has two network paths:

- Live coordination (presence, tasks, intent, conflicts, messages, facts and handoffs) travels over authenticated WebSockets through the coordination service.
- Explicitly selected code/text files travel **directly from the sender's computer to the receiver's computer** over authenticated, certificate-pinned HTTPS. File bytes never go through GitHub, Git push/pull, or the COORD control plane.

Git is used locally to observe changes for coordination. GitHub is where COORD's own source code is saved. Neither is the live sharing transport. Direct transfer works with ordinary folders and uncommitted files, without a Git remote, COORD login, database or control plane.

This is an explicit snapshot transfer, not continuous shared editing. The receiver gets a new private review folder. Nothing is automatically merged, applied to the checkout, opened as a program or executed.

## Quick local proof

Build COORD once:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Set `COORD_ROOT` to the absolute path of this COORD checkout. Set `SOURCE_PROJECT` to a folder with the source files you want to send. In the sender's terminal:

```sh
COORD_ROOT="/absolute/path/to/COORD-STARTUP"
SOURCE_PROJECT="/absolute/path/to/source-project"
node "$COORD_ROOT/dist/coord.js" --repo "$SOURCE_PROJECT" share-files \
  --file src/user.ts \
  --file src/profile.ts
```

The sender prints a JSON summary containing the endpoint, expiry, file count and `invitation_file` path. It **does not print the invitation token**. By default the private invitation is saved under `~/.coord/invitations` (or `$COORD_HOME/invitations`), outside your project. Keep this command running. Its default invitation lifetime is five minutes; Ctrl-C immediately closes the sender's listener.

In a second terminal on the same machine, use the printed invitation path:

```sh
node "$COORD_ROOT/dist/coord.js" --repo /absolute/path/to/receiver-project receive-files \
  --invite /absolute/path/from/invitation_file
```

The receiver prints `hashes_verified: true`, `applied: false`, and a new staged directory under the receiver project's `.coord/inbox`. You can supply `--inbox /private/review-folder` to choose another staging parent. Review and compare the files before copying accepted changes into your working project.

## Two different computers

The receiver must be able to reach the sender. On the same LAN, use the sender's private IP; across the internet, use a reachable private VPN address or an intentionally configured direct endpoint. COORD does not currently provide NAT traversal, port forwarding automation or a TURN relay. Direct-only attempts fail if the computers cannot reach each other.

On Laptop A, replace `192.168.1.25` with its actual reachable address:

```sh
node "$COORD_ROOT/dist/coord.js" --repo "$SOURCE_PROJECT" share-files \
  --file src/user.ts \
  --file src/profile.ts \
  --host 0.0.0.0 \
  --advertise-host 192.168.1.25 \
  --port 4317 \
  --ttl 300
```

Binding to `0.0.0.0` is explicit; the default binds only loopback. For tighter exposure, bind `--host` to the intended LAN/VPN interface itself. The advertised address goes into the invitation and must be reachable by Laptop B. Opening the port in a firewall or configuring a VPN is an operator action; COORD does not modify your network settings.

Send **only the private invitation file** to the intended recipient through an authenticated secure channel. Do not post it in GitHub, commit it, put it in COORD project messages, paste it into logs, or share it publicly. It is an expiring bearer capability: anyone holding it can retrieve this exact selected snapshot while the sender is running. Code contents are not included in the invitation.

On Laptop B:

```sh
chmod 600 /private/path/received-invitation.json
node "$COORD_ROOT/dist/coord.js" --repo /absolute/path/to/sarahs-project receive-files \
  --invite /private/path/received-invitation.json
```

Its own local COORD build reads the invitation, authenticates the sender's TLS certificate against the embedded certificate and fingerprint, downloads directly, verifies each file's SHA-256 and size, and stages the files. Invitations cannot request shell commands or select receiver checkout files to overwrite.

Both sender and receiver must be online during transfer. Interrupted transfers leave no accepted partial snapshot. Retry explicitly; a new receive creates a fresh review directory. Invitations are reusable until expiry/stop, not single-use and not bound to a named COORD user. Files are snapshotted when the share starts; edits afterward require a new share.

## Limits and review policy

- 1–50 explicit files; 4 MiB per file; 16 MiB total.
- UTF-8 source/text files only; binary files and NUL-containing text are rejected in this version.
- Lifetime at most 15 minutes. Network requests have timeouts and bounded response sizes.
- Sensitive paths, credential-like contents, absolute/traversal paths, symlinks and non-regular files are rejected. These filters are conservative heuristics, not a guarantee that every possible secret is recognized.
- No directories are recursively selected, no archives are unpacked, and no Git objects/history/credentials are transferred.
- Received files are non-executable, owner-only and isolated in a new directory. Their contents are untrusted until reviewed.
- No automatic apply, merge, file deletion, repository synchronization or remote agent wake is included.
- Local project and inbox ownership is trusted. Filesystem checks do not guarantee protection against a malicious local process racing directory changes under the same account.

The sender and recipient initiate these local commands explicitly. A coding agent can help select and review files when instructed by its local user, but a remote message does not authorize it to transfer files or run received code. The existing MCP coordination tools do not automatically start file sharing.

## Transport implementation

The sender takes a bounded immutable snapshot, creates a fresh short-lived certificate and random 256-bit capability, and serves a single authenticated HTTPS resource. The receiver uses the invitation certificate as its trust anchor plus an exact SHA-256 certificate pin. TLS authentication happens before its HTTP Authorization header is sent. No certificate checks are disabled globally and no browser security bypass is needed. The service accepts only a read request for the selected snapshot, not arbitrary path requests or uploads.

Implementation follows Node's official [HTTPS request and certificate-pinning documentation](https://nodejs.org/api/https.html) and [TLS identity validation documentation](https://nodejs.org/api/tls.html). A VPN may itself relay encrypted packets when a direct route is unavailable; for example, [Tailscale documents its direct and relayed connection modes](https://tailscale.com/docs/reference/connection-types). COORD does not claim that using a VPN guarantees a physically direct route.
