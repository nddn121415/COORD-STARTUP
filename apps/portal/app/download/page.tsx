export default function Download() {
  return (
    <main className="workspace" style={{ maxWidth: 720 }}>
      <a className="brand" href="/">
        <span className="mark">C</span>COORD
      </a>
      <section className="panel" style={{ marginTop: 40 }}>
        <div className="eyebrow">COORD FOR MAC</div>
        <h1 style={{ fontSize: 40 }}>
          Your team.
          <br />
          On your computer.
        </h1>
        <p>
          Download the app, sign in, and choose your project folder. Everything
          needed to run COORD is included.
        </p>
        <a
          className="primary-link"
          href="https://github.com/nddn121415/COORD-STARTUP/releases/download/desktop-v0.4.0/COORD-0.4.0-mac-arm64.dmg"
        >
          Download for Apple silicon
        </a>
        <p className="small">
          Early access for macOS 13 or later. This first build is unsigned; a
          smooth public installation requires Apple signing and notarization
          before launch.
        </p>
        <ol style={{ paddingLeft: 22, lineHeight: 2.1, marginTop: 28 }}>
          <li>Move COORD into Applications and open it.</li>
          <li>Sign in and approve this computer in your browser.</li>
          <li>Choose a project and a local folder.</li>
        </ol>
        <p className="small">
          Collaborators join your project on the website. File sharing remains
          under your control; received files are staged for review.
        </p>
      </section>
    </main>
  );
}
