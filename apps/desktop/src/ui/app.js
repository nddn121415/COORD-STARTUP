const $ = (id) => document.getElementById(id);
let busy = false;
let latest;
function notice(message) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
}
function text(tag, value, className) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
}
function empty(container, message) {
  container.replaceChildren(text('p', message, 'empty'));
}
function row(title, detail) {
  const el = text('div', '', 'row');
  const body = text('div', '', 'grow');
  body.append(text('strong', title));
  if (detail) body.append(text('p', detail, 'muted small'));
  el.append(body);
  return el;
}
function render(state) {
  latest = state;
  $('status').textContent = state.status || 'Idle';
  $('login').checked = !!state.startAtLogin;
  const active = !!state.folder;
  $('setup').hidden = active;
  $('workspace').hidden = !active;
  $('folder-name').textContent = (state.folder || '').split('/').filter(Boolean).pop() || '';
  $('folder-path').textContent = state.folder || '';
  $('authority-notice').textContent =
    state.authority === 'service'
      ? 'Shared service · The creator’s computer can go offline. The service must remain online.'
      : 'Temporary sharing · The host computer must stay online for this project.';
  $('invite-card').hidden = !state.key;
  $('share-key').value = state.key || '';
  $('integration').textContent =
    typeof state.integrationStatus === 'string'
      ? state.integrationStatus
      : 'Project tools are configured automatically when the folder is connected. Existing agent sessions may need to restart.';
  const pending = state.pending || [];
  $('requests-card').hidden = !pending.length;
  $('requests').replaceChildren();
  for (const peer of pending) {
    const el = row(peer.name || 'New computer', `Connection ID: ${peer.id}`);
    for (const action of ['approve', 'reject']) {
      const button = text(
        'button',
        action === 'approve' ? 'Approve' : 'Reject',
        action === 'approve' ? 'primary' : 'secondary',
      );
      button.onclick = () => act(action, peer.id);
      el.append(button);
    }
    $('requests').append(el);
  }
  $('peers').replaceChildren();
  for (const peer of state.peers || []) {
    const el = row(
      peer.name || peer.id,
      peer.approved ? (peer.online ? 'Connected' : 'Offline') : 'Waiting for approval',
    );
    el.prepend(text('span', '', `dot${peer.online ? ' online' : ''}`));
    if (state.key && peer.approved) {
      const revoke = text('button', 'Remove', 'text');
      revoke.onclick = () => act('revoke', peer.id);
      el.append(revoke);
    }
    $('peers').append(el);
  }
  if (!$('peers').children.length)
    empty(
      $('peers'),
      state.status === 'waiting'
        ? 'Waiting for your teammate to approve this computer.'
        : state.key
          ? 'Share your invite key to connect a teammate.'
          : 'No other computers are currently connected.',
    );
  $('activity').replaceChildren();
  for (const activity of (state.activity || []).slice(-40).reverse())
    $('activity').append(
      row(
        activity.agent || 'Agent',
        [activity.summary, (activity.paths || []).join(', ')].filter(Boolean).join(' · '),
      ),
    );
  if (!$('activity').children.length)
    empty($('activity'), 'Agent updates appear here when project tools are used.');
  $('conflicts').hidden = !(state.conflicts || []).length;
  $('conflicts').textContent = (state.conflicts || []).length
    ? 'Local changes preserved. These files need review before synchronization: ' +
      state.conflicts.join(', ')
    : '';
  $('files').replaceChildren();
  for (const file of (state.files || []).slice(0, 100))
    $('files').append(row(file.path, file.owner ? `Reserved by ${file.owner}` : 'Available'));
  if (!$('files').children.length) empty($('files'), 'Shared project files will appear here.');
  if (state.error) notice(state.error);
}
async function act(action, value) {
  if (busy) return;
  busy = true;
  notice('');
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = await window.coord.action(action, value);
    if (!result.ok) throw new Error(result.error);
    if (result.value) render(result.value);
    if (action === 'copy') notice('Invite key copied. Send it privately to your teammate.');
  } catch (error) {
    notice(error.message || 'Could not finish this action.');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
  }
}
for (const action of ['host', 'copy', 'disconnect', 'reveal', 'quit'])
  $(action).onclick = () => act(action);
$('invite-refresh').onclick = () => act('invite');
$('invite').oninput = () => {
  let computer = false;
  try {
    const key = $('invite').value.trim();
    if (key.startsWith('coord1.') && key.length <= 4096)
      computer =
        JSON.parse(atob(key.slice(7).replace(/-/g, '+').replace(/_/g, '/'))).service !== true;
  } catch {
    /* Backend validates keys before connecting. */
  }
  $('key-help').textContent = computer
    ? 'Computer invite: choose an empty folder for your local copy. The host approves your connection and must stay online.'
    : 'Service keys grant project access without a separate approval. They expire and can be used once—keep yours private. Choose an existing project folder or an empty one; divergent local files are preserved for review.';
};
$('join').onclick = () => act('join', $('invite').value);
$('login').onchange = () => {
  const enabled = $('login').checked;
  if (busy) {
    $('login').checked = !!latest?.startAtLogin;
    return;
  }
  void act('login', String(enabled));
};
window.coord.onState(render);
void act('state');
