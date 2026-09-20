COORD — direct file-transfer tester

Requires Node.js 22.18+ (24 recommended): https://nodejs.org
No Git, pnpm, npm install, login or database needed.

QUICK TEST
Mac: double-click Test COORD.command.
Mac/Linux terminal: sh test-coord.sh
Or on any supported system: node coord-peer.cjs demo
Automatic internet connectivity test: open Test Wi-Fi.command on Mac,
or run: node coord-peer.cjs demo --wifi

If macOS blocks the downloaded launcher, open Terminal in this extracted folder
and run: node coord-peer.cjs demo
This package is not a signed/notarized Mac app. Do not disable system security.

The demo uses real HTTPS between a sender and receiver on YOUR computer.
It checks the downloaded sample and deletes its temporary folders afterward.
It does not prove that a second computer can reach yours.

SEND TO ANOTHER COMPUTER (Mac/Linux)
Both computers need this package, Node and ordinary internet/Wi-Fi.
No VPN, typed IP addresses or router setup is required in automatic mode.
On the sender, replace the folder and file with your actual values:

node coord-peer.cjs --repo /path/to/project share-files --file src/hello.ts --wifi

Keep it running. It prints an invitation_file path, but no secret token.
Send that small invitation file privately to the recipient; do not commit it.
It expires after five minutes. Ctrl-C stops access sooner.

On the receiver:
chmod 600 /path/to/invitation.json
node coord-peer.cjs --repo /path/to/receiver-project receive-files --invite /path/to/invitation.json

The command prints the new review directory. Review files there before copying
accepted changes into your project. Files are not applied or executed for you.

Current limits: UTF-8 text only, 50 files, 4 MiB each, 16 MiB total.
This is snapshot transfer, not continuous synchronization. Automatic mode uses
HyperDHT public discovery and UDP hole punching. Discovery peers can see public
connection metadata (IP/public key), but not the token or source contents.
Some restrictive/guest Wi-Fi networks block UDP or peer connections; there is
no hosted fallback relay yet, so those networks can still fail.
Testing on two physical computers on different networks is still required.
File-transfer support is verified on macOS/Linux; Windows is not yet validated.

HOW THE FULL PRODUCT WORKS
Codex/Claude integrations send coordination metadata to a COORD WebSocket
service backed by PostgreSQL. That service tracks presence, tasks and conflicts.
Selected code files travel directly over HTTPS using the commands above.
GitHub stores COORD's source and downloads; it never carries live file transfers.
This tester does not install agent integrations or start the coordination service.

Full setup: https://github.com/nddn121415/COORD-STARTUP#readme
Details: https://github.com/nddn121415/COORD-STARTUP/blob/main/docs/DIRECT_TRANSFER.md
