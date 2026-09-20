'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ArrowUpRight,
  Check,
  Download,
  Folder,
  Laptop,
  Plus,
  Users,
  X,
} from 'lucide-react';
type Project = { id: string; name: string; ownerId: string };
type State = {
  user: { id: string; name: string; email: string };
  projects: Project[];
  members: { projectId: string; name: string; email: string; userId: string }[];
  devices: { id: string; name: string; lastSeen: number }[];
  invitations: { id: string; projectName: string; senderName: string }[];
};
export default function Workspace({
  user,
  signInUrl,
}: {
  user: { name: string; email: string } | null;
  signInUrl: string;
}) {
  const [state, setState] = useState<State | null>(null),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const r = await fetch('/api/workspace');
    if (!r.ok)
      throw Error('Could not load your workspace. Please sign in again.');
    const d = (await r.json()) as State;
    setState(d);
    setSelected((v) => v || d.projects[0]?.id || '');
  }
  useEffect(() => {
    if (user) refresh().catch((e) => setNotice(e.message));
  }, []);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setNotice('');
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as { error?: string };
      if (!r.ok) throw Error(d.error || 'Please try again.');
      await refresh();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!user) return;
    const context = (
      document as Document & {
        modelContext?: {
          registerTool(
            tool: unknown,
            options: { signal: AbortSignal },
          ): void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tools = [
      {
        name: 'coord_list_projects',
        description: 'Read the signed-in user’s COORD projects.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async () => {
          const r = await fetch('/api/workspace');
          if (!r.ok) throw Error('Sign in to COORD.');
          const data = (await r.json()) as State;
          return { projects: data.projects };
        },
      },
      {
        name: 'coord_create_project',
        description:
          'Create a COORD project and refresh the visible workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
          },
          required: ['name'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: unknown) => {
          const value = input as { name?: unknown };
          if (
            !value ||
            typeof value.name !== 'string' ||
            !value.name.trim() ||
            value.name.length > 100
          )
            throw Error('A project name is required.');
          if (!(await act('/api/projects', { name: value.name })))
            throw Error('Project could not be created.');
          return { created: true };
        },
      },
    ];
    for (const tool of tools)
      try {
        Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => {});
      } catch {
        /* Browser registry unavailable. */
      }
    return () => lifecycle.abort();
  }, [user?.email]);
  const project = state?.projects.find((p) => p.id === selected);
  return (
    <div className="site">
      <header className="top">
        <a className="brand" href="/">
          <span className="mark">C</span>COORD
          <span className="beta">EARLY ACCESS</span>
        </a>
        <div className="account">
          {user ? (
            <>
              <span>{user.name}</span>
              <a href="/signout-with-chatgpt?return_to=/">Sign out</a>
            </>
          ) : (
            <a href={signInUrl} target="_top">
              Sign in <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      </header>
      <main className="workspace">
        <section className="intro">
          <div className="eyebrow">YOUR TEAM. YOUR TOOLS.</div>
          <h1>
            Work together.
            <br />
            <span>Stay in your flow.</span>
          </h1>
          <p>
            Bring your people and their coding agents into one shared project.
            You choose what to share.
          </p>
        </section>
        {!user ? (
          <section className="welcome panel">
            <div className="eyebrow">START WITH YOUR TEAM</div>
            <h2>A shared project, in a few clicks.</h2>
            <div className="steps">
              <div>
                <span>01</span>
                <h3>Create your project</h3>
                <p>Give your team a place to collaborate.</p>
              </div>
              <div>
                <span>02</span>
                <h3>Invite your people</h3>
                <p>Add collaborators by email.</p>
              </div>
              <div>
                <span>03</span>
                <h3>Connect your computer</h3>
                <p>Open COORD and choose your project folder.</p>
              </div>
            </div>
            <a className="primary-link" href={signInUrl} target="_top">
              Continue with ChatGPT <ArrowUpRight size={18} />
            </a>
            <p className="small">
              Your account is used to sign in. Your code is not sent to ChatGPT.
            </p>
          </section>
        ) : (
          <>
            {notice && (
              <div role="status" className="notice">
                {notice}
              </div>
            )}
            {!!state?.invitations.length && (
              <section className="invitations">
                {state.invitations.map((i) => (
                  <div className="panel invite" key={i.id}>
                    <span>
                      <b>{i.senderName}</b> invited you to{' '}
                      <b>{i.projectName}</b>
                    </span>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        act('/api/invitations/accept', { id: i.id })
                      }
                    >
                      Accept invitation
                    </Button>
                  </div>
                ))}
              </section>
            )}
            <div className="grid">
              <section className="panel projects">
                <div className="section-title">
                  <h2>Your projects</h2>
                  <Folder size={20} />
                </div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act('/api/projects', { name })) setName('');
                  }}
                >
                  <Input
                    aria-label="New project name"
                    placeholder="Project name"
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                  <Button disabled={busy || !name.trim()} type="submit">
                    <Plus size={17} />
                    Create
                  </Button>
                </form>
                <div className="project-list">
                  {state?.projects.map((p) => (
                    <button
                      key={p.id}
                      className={
                        selected === p.id ? 'project selected' : 'project'
                      }
                      onClick={() => setSelected(p.id)}
                    >
                      <span className="folder-icon">
                        <Folder size={19} />
                      </span>
                      <span>{p.name}</span>
                      <ArrowUpRight size={17} />
                    </button>
                  ))}
                  {state && !state.projects.length && (
                    <div className="empty">
                      Create your first project to invite a collaborator.
                    </div>
                  )}
                </div>
              </section>
              <section className="panel people">
                <div className="section-title">
                  <div>
                    <div className="eyebrow">
                      {project?.name || 'YOUR WORKSPACE'}
                    </div>
                    <h2>People you build with</h2>
                  </div>
                  <Users size={22} />
                </div>
                {project ? (
                  <>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                          await act('/api/invitations', {
                            projectId: selected,
                            email,
                          })
                        ) {
                          setEmail('');
                          setNotice(
                            'Invitation ready. They’ll see it when they sign in with this email.',
                          );
                        }
                      }}
                    >
                      <Input
                        aria-label="Collaborator email"
                        type="email"
                        placeholder="teammate@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                      <Button disabled={busy || !email} type="submit">
                        Invite
                      </Button>
                    </form>
                    <p className="small">
                      Invitations appear in their COORD account; no email is
                      sent yet.
                    </p>
                    <div className="members">
                      {state?.members
                        .filter((m) => m.projectId === selected)
                        .map((m) => (
                          <div className="member" key={m.userId}>
                            <span className="avatar">
                              {m.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span>
                              <b>{m.name}</b>
                              <small>{m.email}</small>
                            </span>
                            <span className="member-role">
                              {m.userId === project.ownerId
                                ? 'Owner'
                                : 'Member'}
                            </span>
                          </div>
                        ))}
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    Choose a project to see your collaborators.
                  </div>
                )}
              </section>
            </div>
            <section className="panel devices">
              <div>
                <div className="eyebrow">THE DESKTOP APP</div>
                <h2>Your workspace, connected.</h2>
                <p>
                  Download COORD once. Sign in, choose a folder, and keep using
                  your coding tools.
                </p>
                <a className="primary-link" href="/download">
                  <Download size={17} />
                  Download for Mac
                </a>
                <p className="small">
                  Early access · Mac with Apple silicon · signing setup still
                  required before public launch
                </p>
              </div>
              <div className="device-list">
                {state?.devices.length ? (
                  state.devices.map((d) => (
                    <div className="member" key={d.id}>
                      <Laptop size={23} />
                      <span>
                        <b>{d.name}</b>
                        <small>
                          {Date.now() - d.lastSeen < 60000
                            ? 'Connected'
                            : 'Offline'}
                        </small>
                      </span>
                      <Button
                        variant="ghost"
                        aria-label={`Disconnect ${d.name}`}
                        onClick={() => act('/api/devices/revoke', { id: d.id })}
                      >
                        <X size={16} />
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="device-empty">
                    <Laptop size={36} />
                    <h3>No computers connected yet</h3>
                    <p>Open the app and sign in to connect yours.</p>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
        <footer>
          <span>
            <Check size={14} /> Your tools stay yours.
          </span>
          <span>Code moves encrypted. You control what is shared.</span>
        </footer>
      </main>
    </div>
  );
}
