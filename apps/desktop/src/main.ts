import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  safeStorage,
  shell,
  Tray,
} from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPeerSession } from '../peer-session.js';
let window: BrowserWindow | null = null;
let tray: Tray | undefined;
let controller: Awaited<ReturnType<typeof createPeerSession>> | undefined;
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
function state() {
  return { ...controller!.getState(), startAtLogin: app.getLoginItemSettings().openAtLogin };
}
function registerIpc(): void {
  ipcMain.handle('coord:action', async (event, action: unknown, value: unknown) => {
    authorize(event);
    try {
      if (!controller) throw new Error('COORD is still starting.');
      switch (action) {
        case 'state':
          break;
        case 'host':
        case 'join': {
          if (
            action === 'join' &&
            (typeof value !== 'string' || value.length > 4096 || !value.trim())
          )
            throw new Error('Paste an invite key first.');
          const picked = await dialog.showOpenDialog(window!, {
            title:
              action === 'host'
                ? 'Choose the project to share'
                : 'Choose an empty folder for your project copy',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (!picked.canceled && picked.filePaths[0]) {
            const folder = await realpath(picked.filePaths[0]);
            if (action === 'host') await controller.host(folder);
            else await controller.join((value as string).trim(), folder);
          }
          break;
        }
        case 'copy': {
          const key = controller.getState().key;
          if (!key) throw new Error('Start sharing to create an invite key.');
          clipboard.writeText(key);
          break;
        }
        case 'approve':
        case 'reject':
        case 'revoke':
          if (typeof value !== 'string' || value.length > 200)
            throw new Error('Choose a connection request.');
          if (action === 'approve') await controller.approve(value);
          else if (action === 'reject') await controller.reject(value);
          else await controller.revoke(value);
          break;
        case 'invite':
          await controller.invite();
          break;
        case 'disconnect':
          await controller.disconnect();
          break;
        case 'reveal': {
          const folder = controller.getState().folder;
          if (!folder) throw new Error('Choose a folder first.');
          const error = await shell.openPath(folder);
          if (error) throw new Error('Could not open the project folder.');
          break;
        }
        case 'login':
          if (value !== 'true' && value !== 'false') throw new Error('Invalid login preference.');
          app.setLoginItemSettings({ openAtLogin: value === 'true' });
          break;
        case 'quit':
          app.quit();
          break;
        default:
          throw new Error('Unknown desktop action');
      }
      return { ok: true, value: state() };
    } catch (error) {
      return {
        ok: false,
        error: (error instanceof Error ? error.message : 'The operation could not finish.').slice(
          0,
          400,
        ),
      };
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
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => {
    window = null;
  });
  await window.loadFile(uiPath);
}
function showWindow() {
  if (window) {
    window.show();
    window.focus();
  } else void createWindow();
}
function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVQ4T2NkYGD4z0ABYBxVMGoAAzAMBgAAT8wBH2vQGZkAAAAASUVORK5CYII=',
  );
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setTitle('COORD');
  tray.setToolTip('COORD — local project collaboration');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open COORD', click: showWindow },
      { type: 'separator' },
      { label: 'Quit COORD', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      )
        throw new Error('Unlock your system keychain before opening COORD.');
      controller = await createPeerSession({
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
        onStateChanged: () => {
          if (controller) window?.webContents.send('coord:state', state());
        },
        integration: {
          command: '/usr/bin/env',
          args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, join(__dirname, 'local-mcp.cjs')],
        },
      });
      registerIpc();
      createTray();
      await createWindow();
      app.on('activate', showWindow);
    })
    .catch(() => {
      dialog.showErrorBox(
        'COORD could not start',
        'COORD could not unlock its protected local state. Unlock your system keychain and check that your account can write to its application support folder, then reopen the app.',
      );
      app.quit();
    });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.resolve(controller?.dispose()).finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    /* The tray keeps the shared project online. */
  });
}
