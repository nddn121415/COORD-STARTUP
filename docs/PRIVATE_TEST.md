# COORD private test

Use two Apple silicon Macs running macOS 13 or later, two Google accounts, and a disposable project folder. The current build is for a small private test. It is ad-hoc signed and not Apple-notarized; if macOS blocks opening it, record the message rather than disabling system protections.

## Connect both people

1. Both people download the same current build from [the COORD website](https://coord-startup-control-plane.vercel.app/download).
2. Sign in with Google on the website. The owner creates a project (or uses **COORD private test**) and clicks **Create invitation**. Send that one-use key privately to the other person, who signs in with their own account and uses **Join your team**.
3. Each person opens COORD, clicks **Sign in through website**, and approves only the code displayed on their own computer.
4. In the app, choose the shared project and a local folder. For this test, start with empty folders on both computers. Keep COORD running in the menu bar.

## Verify the connection

1. On the first Mac, create `hello.txt` in the selected folder with `Hello from the first Mac`. Within a few seconds, check that the second Mac receives it.
2. Edit that file on the second Mac to `Hello from the second Mac`. Confirm that the first receives the edit. Also check creating and deleting a separate disposable file.
3. Fully quit COORD on the first Mac. Edit `hello.txt` on the second Mac, then reopen COORD on the first. Confirm that it catches up without a new invitation.
4. Disconnect the second Mac from the internet, edit a file there, then reconnect. With no competing edit, its draft should synchronize. With competing edits, COORD should preserve the local draft and show the path for review.

## Verify agent coordination

Open fresh Codex or Claude sessions in the selected folders and approve the normal project integration prompt. Ask the first agent:

> Use COORD to create your isolated workspace. Reserve hello.txt with the summary "Private test: first agent". Keep the reservation until I ask you to release it.

Ask the second agent:

> Read COORD's team activity. Try to reserve hello.txt. If it is reserved, explain who is working on it and choose a different file; do not edit the shared folder directly.

The second reservation should be rejected with a useful explanation. Release the first agent's reservation and verify that the second can reserve it, edit in its isolated workspace, submit, and release. Ordinary editors do not participate in reservations; use the COORD tools for managed publication.

Finally, use the owner's website to remove the second member. The second computer must lose access to new shared data and publication. Its existing local files should remain. A fresh invitation is required to join again.

## What is verified so far

Google login and account persistence were tested against the deployed website. Real project creation was verified under the owner's Google account. Automated tests cover independent desktop clients, PostgreSQL persistence, offline/restart recovery, reserved publication, and revocation; they do not prove a completed test on two physical computers. Complete the steps above before expanding the test group. Agent activity comes from the project tools; COORD does not read private conversations or remotely control every existing agent session.
