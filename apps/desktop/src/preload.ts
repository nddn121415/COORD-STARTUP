import { contextBridge, ipcRenderer } from 'electron';
const allowed = new Set([
  'state',
  'host',
  'join',
  'copy',
  'approve',
  'reject',
  'revoke',
  'invite',
  'disconnect',
  'reveal',
  'login',
  'quit',
]);
contextBridge.exposeInMainWorld(
  'coord',
  Object.freeze({
    action(action: string, value?: string) {
      if (!allowed.has(action) || (value !== undefined && typeof value !== 'string'))
        return Promise.resolve({ ok: false, error: 'Unsupported action' });
      return ipcRenderer.invoke('coord:action', action, value);
    },
    onState(callback: (state: unknown) => void) {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on('coord:state', listener);
      return () => ipcRenderer.removeListener('coord:state', listener);
    },
  }),
);
