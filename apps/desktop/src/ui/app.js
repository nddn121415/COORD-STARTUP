'use strict';
const $ = (id) => document.getElementById(id);
let state = { status: 'signed-out', projects: [], devices: [], transfers: [] };
let selectedDevice;
let busy = false;
let noticeTimer;
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function notice(message, permanent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = !message;
  if (!permanent && message)
    noticeTimer = setTimeout(() => {
      $('notice').hidden = true;
    }, 12000);
}
async function act(action, value) {
  if (busy && action !== 'state') return;
  busy = true;
  render();
  try {
    const response = await window.coord.action(action, value);
    if (!response.ok) throw new Error(response.error);
    if (action === 'pair')
      notice('Your browser is open. Sign in and confirm the code shown below.');
    else if (action === 'send')
      notice('Your files are ready for your teammate. Keep COORD open until they receive them.');
    else if (action === 'integration')
      notice(
        `${value === 'codex' ? 'Codex' : 'Claude'} connected. Restart its session to load COORD.`,
      );
    else if (action === 'receive')
      notice('Files received into a separate folder. Your project has not been changed.');
    if (response.value?.status) state = response.value;
  } catch (error) {
    notice(
      error instanceof Error
        ? error.message
        : 'COORD could not finish the request. Please try again.',
    );
  } finally {
    busy = false;
    render();
  }
}
function empty(container, symbol, message) {
  const node = el('div', 'empty-state');
  node.append(el('span', 'symbol', symbol), el('span', '', message));
  container.append(node);
}
function render() {
  const connected = state.status === 'connected';
  const project = state.projects.find((item) => item.id === state.projectId);
  $('signin-panel').hidden = connected;
  $('workspace-panel').hidden = !connected;
  $('heading').textContent = connected
    ? (project?.name ?? 'Your workspace')
    : 'Your team. In sync.';
  $('subheading').textContent = connected
    ? 'Share work with the people building alongside you.'
    : 'Bring your local work into the conversation.';
  $('breadcrumb').textContent = connected ? (project?.name ?? 'Projects') : 'Get started';
  $('connection-label').textContent = connected
    ? 'Account connected'
    : state.status === 'pairing'
      ? 'Waiting for sign-in'
      : 'Not connected';
  $('connection-dot').classList.toggle('online', connected && !state.error);
  $('status-pill').textContent = busy
    ? 'Working…'
    : state.error
      ? 'Needs attention'
      : connected
        ? 'Connected'
        : state.status === 'pairing'
          ? 'Pairing'
          : 'Not signed in';
  $('status-pill').classList.toggle('online', connected && !state.error);
  $('logout').hidden = !connected;
  $('logout').disabled = busy;
  $('pair').disabled = busy || state.status === 'pairing';
  $('pair').textContent =
    state.status === 'pairing' ? 'Waiting for your browser…' : 'Connect your account ↗';
  $('pairing').hidden = !state.pairing;
  if (state.pairing) {
    $('pairing-code').textContent = state.pairing.userCode;
    $('pairing-expiry').textContent =
      `Expires at ${new Date(state.pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  $('projects').replaceChildren();
  if (!connected) $('projects').append(el('p', 'sidebar-note', 'Sign in to see your projects.'));
  else if (!state.projects.length)
    $('projects').append(el('p', 'sidebar-note', 'Create a project on the website.'));
  for (const item of state.projects) {
    const button = el(
      'button',
      `project-button${item.id === state.projectId ? ' selected' : ''}`,
      item.name,
    );
    button.disabled = busy;
    button.addEventListener('click', () => {
      selectedDevice = undefined;
      void act('project', item.id);
    });
    $('projects').append(button);
  }
  $('no-project').hidden = !!state.projects.length;
  $('project-workspace').hidden = !state.projects.length;
  $('folder-name').textContent = state.folder
    ? state.folder.split('/').filter(Boolean).pop()
    : 'Choose the folder you work in';
  $('folder-path').textContent =
    state.folder ?? 'Your files stay local until you choose to send them.';
  $('folder').textContent = state.folder ? 'Change folder' : 'Choose folder';
  $('folder').disabled = busy || !project;
  $('device-count').textContent = String(state.devices.length);
  $('devices').replaceChildren();
  if (!state.devices.some((device) => device.id === selectedDevice)) selectedDevice = undefined;
  if (!state.devices.length)
    empty(
      $('devices'),
      '⌘',
      'No other computers yet. Invite a teammate on the website and have them connect COORD.',
    );
  for (const device of state.devices) {
    const row = el('label', `device-row${selectedDevice === device.id ? ' selected' : ''}`);
    const avatar = el(
      'span',
      'avatar',
      (device.name || device.email || '?').slice(0, 1).toUpperCase(),
    );
    const info = el('span', 'grow');
    info.append(el('span', 'device-name', device.name), el('span', 'device-detail', device.email));
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'device';
    radio.value = device.id;
    radio.checked = selectedDevice === device.id;
    radio.disabled = busy;
    radio.addEventListener('change', () => {
      selectedDevice = device.id;
      render();
    });
    row.append(avatar, info, radio);
    $('devices').append(row);
  }
  $('send').disabled = busy || state.sending || !selectedDevice || !state.folder || !project;
  $('send').textContent = state.sending ? 'Preparing files…' : 'Select files to send ↗';
  $('transfer-count').textContent = String(state.transfers.length);
  $('transfers').replaceChildren();
  if (!state.transfers.length)
    empty(
      $('transfers'),
      '↓',
      'Nothing waiting for you. Files sent by your teammates will appear here.',
    );
  for (const transfer of state.transfers) {
    const row = el('div', 'transfer-row'),
      info = el('div');
    info.append(
      el('strong', '', `From ${transfer.senderName}`),
      el(
        'small',
        '',
        `Available until ${new Date(transfer.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      ),
    );
    const button = el('button', 'button secondary', 'Receive');
    button.disabled = busy || !state.folder;
    button.addEventListener('click', () => {
      void act('receive', transfer.id);
    });
    row.append(info, button);
    $('transfers').append(row);
  }
  $('received').hidden = !state.lastReceived;
  $('received-path').textContent = state.lastReceived ?? '';
  $('received-route').textContent =
    state.lastTransferRoute === 'direct'
      ? 'Received directly from your teammate’s computer.'
      : state.lastTransferRoute === 'encrypted-relay'
        ? 'Received through an encrypted relay. Only your computer can decrypt the files.'
        : '';
  $('reveal').disabled = busy;
  $('codex').disabled = busy || !state.folder || !project || !state.integrationAvailable;
  $('claude').disabled = busy || !state.folder || !project || !state.integrationAvailable;
  $('refresh').disabled = busy;
  if (state.error) notice(state.error, true);
}
$('reveal').addEventListener('click', () => {
  void act('reveal');
});
$('pair').addEventListener('click', () => {
  void act('pair');
});
$('website').addEventListener('click', () => {
  void act('website');
});
$('create-project').addEventListener('click', () => {
  void act('website');
});
$('refresh').addEventListener('click', () => {
  void act('refresh');
});
$('folder').addEventListener('click', () => {
  void act('folder');
});
$('send').addEventListener('click', () => {
  if (selectedDevice) void act('send', selectedDevice);
});
$('logout').addEventListener('click', () => {
  void act('logout');
});
$('codex').addEventListener('click', () => {
  void act('integration', 'codex');
});
$('claude').addEventListener('click', () => {
  void act('integration', 'claude');
});
$('overview').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.coord.onState((next) => {
  state = next;
  render();
});
void act('state');
