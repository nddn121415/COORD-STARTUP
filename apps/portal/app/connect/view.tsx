'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Laptop, Check } from 'lucide-react';
export default function Connect({ code }: { code: string }) {
  const [device, setDevice] = useState<{
      name: string;
      fingerprint: string;
    } | null>(null),
    [error, setError] = useState(''),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/device/details?code=${encodeURIComponent(code)}`)
      .then(async (r) => {
        const d = (await r.json()) as {
          error?: string;
          name: string;
          fingerprint: string;
        };
        if (!r.ok) throw Error(d.error);
        setDevice(d);
      })
      .catch((e) => setError(e.message));
  }, [code]);
  async function approve() {
    setBusy(true);
    try {
      const r = await fetch('/api/device/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode: code }),
      });
      const d = (await r.json()) as {
        error?: string;
        name: string;
        fingerprint: string;
      };
      if (!r.ok) throw Error(d.error);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace" style={{ maxWidth: 640, paddingTop: 100 }}>
      <a className="brand" href="/">
        <span className="mark">C</span>COORD
      </a>
      <section className="panel" style={{ marginTop: 36 }}>
        {done ? (
          <>
            <Check size={34} />
            <h2 style={{ marginTop: 20 }}>Your computer is connected.</h2>
            <p>Return to COORD and choose your project folder.</p>
            <a className="primary-link" href="/">
              Back to your projects
            </a>
          </>
        ) : (
          <>
            <Laptop size={34} />
            <h2 style={{ marginTop: 20 }}>
              Connect {device?.name || 'your computer'}?
            </h2>
            <p style={{ margin: '16px 0', color: '#627087' }}>
              Only approve this if you just clicked Sign in in the COORD app on
              your computer.
            </p>
            <p className="small">
              Connection code: <b>{code}</b>
            </p>
            {device && (
              <p className="small">Device fingerprint: {device.fingerprint}</p>
            )}
            <Button disabled={!device || busy || !!error} onClick={approve}>
              Connect this computer
            </Button>
            <a href="/" style={{ marginLeft: 20, fontSize: 14 }}>
              Cancel
            </a>
          </>
        )}
        {error && (
          <p role="alert" className="notice" style={{ marginTop: 20 }}>
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
