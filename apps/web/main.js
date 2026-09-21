const $ = (selector) => document.querySelector(selector);
let user = null,
  selected = null;
function notify(message, error = false) {
  const element = $('#notice');
  element.textContent = message;
  element.hidden = !message;
  element.className = error ? 'error' : 'success';
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch('/api/account/' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      user = null;
      showAccount();
    }
    throw new Error(value.error || 'Request failed. Please try again.');
  }
  return value;
}
async function run(button, action) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    notify(error.message || 'Please try again.', true);
  } finally {
    if (button) button.disabled = false;
  }
}
function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}
function showAccount() {
  $('#auth').hidden = !!user;
  $('#workspace').hidden = !user;
  $('#logout').hidden = !user;
  $('#identity').textContent = user ? '@' + user.username : '';
  $('#pairing').hidden = !user || location.pathname !== '/connect';
  if (!user) $('#detail').hidden = true;
}
async function load() {
  const result = await api('workspace');
  user = result.user;
  showAccount();
  const container = $('#projects');
  container.replaceChildren();
  if (!result.projects.length)
    container.append(
      node('p', 'No projects yet. Create one below, or join with an invitation key.', 'empty'),
    );
  for (const project of result.projects) {
    const card = node('button', undefined, 'project');
    card.append(
      node('span', '◈', 'project-mark'),
      node('h3', project.name),
      node('span', project.role, 'role'),
    );
    card.addEventListener('click', () => run(card, () => detail(project.id)));
    container.append(card);
  }
}
async function detail(id) {
  const result = await api('projects/' + id);
  selected = id;
  const panel = $('#detail');
  panel.replaceChildren();
  panel.hidden = false;
  const heading = node('div', undefined, 'section-heading');
  heading.append(node('h2', result.name));
  if (result.role === 'owner') {
    const invite = node('button', 'Create invitation', 'primary');
    invite.addEventListener('click', () =>
      run(invite, async () => {
        const value = await api('projects/' + id + '/invitations', {});
        let box = panel.querySelector('.invitation');
        if (!box) {
          box = node('div', undefined, 'invitation');
          panel.prepend(box);
        }
        box.replaceChildren(node('p', 'Share this one-time key privately with your teammate:'));
        const input = node('input');
        input.value = value.key;
        input.readOnly = true;
        input.setAttribute('aria-label', 'Invitation key');
        box.append(input);
        const copy = node('button', 'Copy key');
        copy.addEventListener('click', () =>
          run(copy, async () => {
            await navigator.clipboard.writeText(value.key);
            notify('Invitation copied.');
          }),
        );
        box.append(copy);
      }),
    );
    heading.append(invite);
  }
  panel.append(
    heading,
    node('p', 'Open this project in the desktop app to connect its local folder.'),
  );
  panel.append(node('h3', 'Members'));
  const members = node('div', undefined, 'members');
  for (const member of result.members ?? []) {
    const row = node('div', undefined, 'member');
    row.append(node('span', '@' + member.username), node('span', member.role, 'role'));
    if (result.role === 'owner' && member.role !== 'owner') {
      const remove = node('button', 'Remove');
      remove.addEventListener('click', () =>
        run(remove, async () => {
          if (!confirm('Remove @' + member.username + ' and disconnect their project devices?'))
            return;
          await api('projects/' + id + '/members/' + (member.userId ?? member.id), {}, 'DELETE');
          await detail(id);
          notify('Member removed.');
        }),
      );
      row.append(remove);
    }
    members.append(row);
  }
  panel.append(members, node('h3', 'Connected computers'));
  for (const device of result.devices ?? []) {
    const row = node('div', undefined, 'member');
    row.append(
      node('span', device.name || 'COORD desktop'),
      node('span', device.id.slice(0, 12), 'role'),
    );
    if (result.role === 'owner' || device.userId === user.id) {
      const revoke = node('button', 'Revoke access');
      revoke.addEventListener('click', () =>
        run(revoke, async () => {
          if (!confirm('Sign this computer out of all its COORD projects?')) return;
          await api('projects/' + id + '/devices/' + device.id, {}, 'DELETE');
          await detail(id);
          notify('Computer access revoked.');
        }),
      );
      row.append(revoke);
    }
    panel.append(row);
  }
  panel.append(node('h3', 'Agent activity'));
  if (!(result.activity ?? []).length)
    panel.append(node('p', 'No active agents reporting yet.', 'muted'));
  for (const activity of result.activity ?? [])
    panel.append(
      node('p', (activity.agent || 'Agent') + ' · ' + (activity.summary || 'Connected')),
    );
  for (const conflict of result.conflicts ?? []) panel.append(node('p', conflict, 'error'));
}
$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void run(form.querySelector('[type=submit]'), async () => {
    await api('login', Object.fromEntries(new FormData(form)));
    form.reset();
    await load();
    notify('Signed in.');
  });
});
$('#register').addEventListener(
  'click',
  (event) =>
    void run(event.currentTarget, async () => {
      const form = $('#auth-form');
      if (!form.reportValidity()) return;
      await api('register', Object.fromEntries(new FormData(form)));
      form.reset();
      await load();
      notify('Account created.');
    }),
);
$('#logout').addEventListener(
  'click',
  (event) =>
    void run(event.currentTarget, async () => {
      await api('logout', {});
      user = null;
      selected = null;
      showAccount();
      notify('Signed out.');
    }),
);
$('#refresh').addEventListener(
  'click',
  (event) =>
    void run(event.currentTarget, async () => {
      await load();
      if (selected) await detail(selected);
    }),
);
$('#create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void run(form.querySelector('button'), async () => {
    const value = await api('projects', Object.fromEntries(new FormData(form)));
    form.reset();
    await load();
    await detail(value.id);
    notify('Project created. Open it in the desktop app.');
  });
});
$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void run(form.querySelector('button'), async () => {
    await api('invitations/accept', Object.fromEntries(new FormData(form)));
    form.reset();
    await load();
    notify('You joined the project. Select it in the desktop app.');
  });
});
$('#pair-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void run(form.querySelector('button'), async () => {
    await api('device/approve', { userCode: form.elements.code.value.trim() });
    form.reset();
    $('#pairing').hidden = true;
    notify('Computer approved. Return to the COORD desktop app.');
  });
});
if (location.pathname === '/connect') {
  const code = new URLSearchParams(location.search).get('code');
  if (code) $('#pair-form').elements.code.value = code.slice(0, 20);
  history.replaceState(null, '', '/connect');
}
void load().catch((error) => {
  showAccount();
  if (error.message !== 'Unauthorized' && !/session|sign in|authentication/i.test(error.message))
    notify(error.message, true);
});
