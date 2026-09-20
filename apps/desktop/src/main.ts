import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join, relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDesktopController } from '../service.js';
declare const __COORD_PORTAL_URL__: string;
const portalUrl = __COORD_PORTAL_URL__;
let window: BrowserWindow | null = null;
let controller: Awaited<ReturnType<typeof createDesktopController>> | undefined;
const uiPath = join(__dirname, 'ui', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;
let quitting = false;

function authorize(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== uiUrl
  )
    throw new Error('Untrusted desktop request');
}
function requireController() {
  if (!controller) throw new Error('COORD is still starting. Please try again.');
  return controller;
}
async function openPortal(url: string): Promise<void> {
  if (!portalUrl) throw new Error('The collaboration website is not configured in this build.');
  const target = new URL(url),
    configured = new URL(portalUrl);
  if (
    target.origin !== configured.origin ||
    target.username ||
    target.password ||
    !['https:', 'http:'].includes(target.protocol)
  )
    throw new Error('COORD refused an untrusted website address.');
  await shell.openExternal(target.href);
}
function registerIpc(): void {
  ipcMain.handle('coord:action', async (event, action: unknown, value: unknown) => {
    authorize(event);
    try {
      const service = requireController();
      switch (action) {
        case 'state':
          return { ok: true, value: service.getState() };
        case 'refresh':
          await service.refresh();
          break;
        case 'pair': {
          if (
            !safeStorage.isEncryptionAvailable() ||
            (process.platform === 'linux' &&
              safeStorage.getSelectedStorageBackend() === 'basic_text')
          )
            throw new Error('Unlock your system keychain before signing in.');
          const pairing = await service.beginPairing();
          await openPortal(pairing.url);
          return { ok: true, value: { userCode: pairing.userCode, expiresAt: pairing.expiresAt } };
        }
        case 'website':
          await openPortal(portalUrl);
          break;
        case 'project':
          if (typeof value !== 'string' || value.length > 200) throw new Error('Choose a project.');
          await service.selectProject(value);
          break;
        case 'folder': {
          const picked = await dialog.showOpenDialog(window!, {
            title: 'Choose your local project folder',
            properties: ['openDirectory'],
          });
          if (!picked.canceled && picked.filePaths[0])
            await service.setFolder(await realpath(picked.filePaths[0]));
          break;
        }
        case 'send': {
          if (typeof value !== 'string' || value.length > 200)
            throw new Error('Choose a teammate’s computer.');
          const state = service.getState();
          if (!state.folder) throw new Error('Choose your local project folder first.');
          const picked = await dialog.showOpenDialog(window!, {
            title: 'Select files to send',
            defaultPath: state.folder,
            properties: ['openFile', 'multiSelections'],
          });
          if (picked.canceled || !picked.filePaths.length) break;
          const paths = picked.filePaths.map((path) => relative(state.folder!, path));
          if (paths.some((path) => isAbsolute(path) || path === '..' || path.startsWith('../')))
            throw new Error('Choose files inside your selected project folder.');
          await service.sendFiles(paths, value);
          break;
        }
        case 'reveal': {
          const received = service.getState().lastReceived;
          if (!received) throw new Error('Receive files before opening their review folder.');
          const error = await shell.openPath(received);
          if (error) throw new Error('Could not open the review folder.');
          break;
        }
        case 'receive':
          if (typeof value !== 'string' || value.length > 200)
            throw new Error('Choose a file transfer.');
          await service.acceptTransfer(value);
          break;
        case 'integration':
          if (value !== 'codex' && value !== 'claude') throw new Error('Choose Codex or Claude.');
          await service.installIntegration(value);
          break;
        case 'logout':
          await service.logout();
          break;
        default:
          throw new Error('Unknown desktop action');
      }
      return { ok: true, value: service.getState() };
    } catch (error) {
      // Service errors are deliberately user-safe. Never serialize stack traces or request objects.
      const message = error instanceof Error ? error.message : 'The operation could not finish.';
      return { ok: false, error: message.slice(0, 400) };
    }
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1110,
    height: 800,
    minWidth: 850,
    minHeight: 660,
    title: 'COORD',
    backgroundColor: '#f6f8fc',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => {
    window = null;
  });
  await window.loadFile(uiPath);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      controller = await createDesktopController({
        portalUrl,
        stateDirectory: app.getPath('userData'),
        protect: {
          encryptString(value) {
            if (
              !safeStorage.isEncryptionAvailable() ||
              (process.platform === 'linux' &&
                safeStorage.getSelectedStorageBackend() === 'basic_text')
            )
              throw new Error('System keychain is unavailable.');
            return safeStorage.encryptString(value);
          },
          decryptString(value) {
            return safeStorage.decryptString(value);
          },
        },
        onStateChanged: (state) => {
          window?.webContents.send('coord:state', state);
        },
        ...(process.platform === 'win32'
          ? {}
          : {
              integration: {
                command: '/usr/bin/env',
                args: [
                  'ELECTRON_RUN_AS_NODE=1',
                  process.execPath,
                  join(__dirname, 'coord-mcp.cjs'),
                ],
              },
            }),
      });
      registerIpc();
      await createWindow();
      app.on('activate', () => {
        if (!window) void createWindow();
      });
    })
    .catch(() => {
      dialog.showErrorBox(
        'COORD could not start',
        'COORD could not open its local state. Check that your user account can write to its application support folder, then reopen the app.',
      );
      app.quit();
    });
  app.on('before-quit', (event) => {
    if (quitting || !controller) return;
    event.preventDefault();
    quitting = true;
    void controller.dispose().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
