import {
    getPopupTarget,
    initPopupsConfigurationMain,
    setupPictureInPictureMain,
    setupPowerMonitorMain,
    setupRemoteControlMain,
    setupScreenSharingMain
} from '@jitsi/electron-sdk/main';
import {
    BrowserWindow,
    Menu,
    app,
    dialog,
    ipcMain
} from 'electron';
import contextMenu from 'electron-context-menu';
import debug from 'electron-debug';
import isDev from 'electron-is-dev';
import log from 'electron-log';
import electronReload from 'electron-reload';
import { autoUpdater } from 'electron-updater';
import windowStateKeeper from 'electron-window-state';
import * as path from 'path';
import * as URL from 'url';
import * as fs from 'fs';
import * as crypto from 'crypto';

import config from './app/features/config';
import { openExternalLink } from './app/features/utils/openExternalLink';
import { t } from './app/i18n/main';
import pkgJson from './package.json';

// This file is bundled to ./build/main.js, so under esbuild __dirname is the
// build/ directory and its parent is the application root holding build/ and
// resources/ (in both development and the packaged app). Do not use __dirname
// directly for app paths: the previous webpack build neutralised __dirname via
// `node: { __dirname: true }`, so this indirection replaces that behaviour.
const rootDir = path.resolve(__dirname, '..');

if (process.env.JITSI_MEET_USER_DATA) {
    app.setPath('userData', process.env.JITSI_MEET_USER_DATA);
}

const showDevTools = Boolean(process.env.SHOW_DEV_TOOLS) || (process.argv.indexOf('--show-dev-tools') > -1);

// Fix screen-sharing thumbnails being missing sometimes.
// https://github.com/electron/electron/issues/44504
const disabledFeatures = [
    'ThumbnailCapturerMac:capture_mode/sc_screenshot_manager',
    'ScreenCaptureKitPickerScreen',
    'ScreenCaptureKitStreamPickerSonoma'
];

app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

// Enable Opus RED field trial.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Audio-Red-For-Opus/Enabled/');

// Wayland: Enable optional PipeWire support.
if (!app.commandLine.hasSwitch('enable-features')) {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

if (process.env.IGNORE_CERTIFICATE_ERRORS === 'true' || process.argv.includes('--ignore-certificate-errors')) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
}

autoUpdater.logger = log;
log.transports.file.level = 'info';

// Enable context menu so things like copy and paste work in input fields.
contextMenu({
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    showCopyImage: false,
    showCopyImageAddress: false,
    showSaveImage: false,
    showSaveImageAs: false,
    showInspectElement: true,
    showServices: false
});

// Enable DevTools also on release builds to help troubleshoot issues. Don't
// show them automatically though.
debug({
    isEnabled: true,
    showDevTools
});

/**
 * When in development mode:
 * - Enable automatic reloads
 */
if (isDev) {
    electronReload(path.join(rootDir, 'build'));
}

/**
 * The window object that will load the iframe with Jitsi Meet.
 * IMPORTANT: Must be defined as global in order to not be garbage collected
 * acidentally.
 */
let mainWindow: BrowserWindow | null = null;

/**
 * Window 2: Meeting window — created on demand, full size.
 * IMPORTANT: Must be defined as global to avoid garbage collection.
 */
let meetingWindow: BrowserWindow | null = null;


/**
 * Add protocol data
 */
const appProtocolSurplus = `${config.appProtocolPrefix}://`;
let rendererReady = false;
let protocolDataForFrontApp: string | null = null;


/**
 * Sets the application menu. It is hidden on all platforms except macOS because
 * otherwise copy and paste functionality is not available.
 */
function setApplicationMenu() {
    if (process.platform === 'darwin') {
        const template: Electron.MenuItemConstructorOptions[] = [ {
            label: app.name,
            submenu: [
                {
                    role: 'services',
                    submenu: []
                },
                { type: 'separator' },
                { role: 'hide' },
                // NOTE: kept as the original (lowercase) role string to preserve
                // behaviour; the typed role union only knows 'hideOthers'.
                { role: 'hideothers' } as unknown as Electron.MenuItemConstructorOptions,
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }, {
            label: 'Edit',
            submenu: [
                {
                    label: 'Undo',
                    accelerator: 'CmdOrCtrl+Z',
                    selector: 'undo:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Redo',
                    accelerator: 'Shift+CmdOrCtrl+Z',
                    selector: 'redo:'
                } as Electron.MenuItemConstructorOptions,
                {
                    type: 'separator'
                },
                {
                    label: 'Cut',
                    accelerator: 'CmdOrCtrl+X',
                    selector: 'cut:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Copy',
                    accelerator: 'CmdOrCtrl+C',
                    selector: 'copy:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Paste',
                    accelerator: 'CmdOrCtrl+V',
                    selector: 'paste:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Select All',
                    accelerator: 'CmdOrCtrl+A',
                    selector: 'selectAll:'
                } as Electron.MenuItemConstructorOptions
            ]
        }, {
            label: '&Window',
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        } ];

        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } else {
        Menu.setApplicationMenu(null);
    }
}

/**
 * Opens new window with index.html(Jitsi Meet is loaded in iframe there).
 */
function createJitsiMeetWindow() {
    // Application menu.
    setApplicationMenu();

    // Check for Updates.
    if (!process.mas) {
        autoUpdater.checkForUpdatesAndNotify();
    }

    // Load the previous window state with fallback to defaults.
    const windowState = windowStateKeeper({
        defaultHeight: 600,
        fullScreen: false
    });

    // Path to root directory.
    const basePath = isDev ? rootDir : app.getAppPath();

    // URL for index.html which will be our entry point.
    const indexURL = URL.format({
        pathname: path.resolve(basePath, './build/index.html'),
        protocol: 'file:',
        slashes: true
    });

    // Options used when creating the main Jitsi Meet window.
    // Use a preload script in order to provide node specific functionality
    // to a isolated BrowserWindow in accordance with electron security
    // guideline.
    const options: Electron.BrowserWindowConstructorOptions = {
        x: windowState.x,
        y: windowState.y,
        width: 480,
        height: windowState.height,
        icon: path.resolve(basePath, './resources/icon.png'),
        minWidth: 480,
        minHeight: 600,
        show: false,
        webPreferences: {
            enableBlinkFeatures: 'WebAssemblyCSP',
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.resolve(basePath, './build/preload.js'),
            sandbox: true
        }
    };

    mainWindow = new BrowserWindow(options);
    windowState.manage(mainWindow);
    mainWindow.loadURL(indexURL);

    if (isDev) {
        mainWindow.webContents.session.clearCache();
    }

    // Block access to file:// URLs.
    const fileFilter = {
        urls: [ 'file://*' ]
    };

    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(fileFilter, (details, callback) => {
        const requestedPath = path.resolve(URL.fileURLToPath(details.url));
        const appBasePath = path.resolve(basePath);

        if (!requestedPath.startsWith(appBasePath)) {
            callback({ cancel: true });
            console.warn(`Rejected file URL: ${details.url}`);

            return;
        }

        callback({ cancel: false });
    });

    // Filter out x-frame-options and frame-ancestors CSP to allow loading jitsi via the iframe API
    // Resolves https://github.com/jitsi/jitsi-meet-electron/issues/285
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = details.responseHeaders ?? {};

        delete responseHeaders['x-frame-options'];

        if (responseHeaders['content-security-policy']) {
            const cspFiltered = responseHeaders['content-security-policy'][0]
                .split(';')
                .filter(x => x.indexOf('frame-ancestors') === -1)
                .join(';');

            responseHeaders['content-security-policy'] = [ cspFiltered ];
        }

        if (responseHeaders['Content-Security-Policy']) {
            const cspFiltered = responseHeaders['Content-Security-Policy'][0]
                .split(';')
                .filter(x => x.indexOf('frame-ancestors') === -1)
                .join(';');

            responseHeaders['Content-Security-Policy'] = [ cspFiltered ];
        }

        callback({
            responseHeaders
        });
    });

    // Block redirects.
    const allowedRedirects = [
        'http:',
        'https:',
        'ws:',
        'wss:'
    ];

    mainWindow.webContents.addListener('will-redirect', (ev, url) => {
        const requestedUrl = new URL.URL(url);

        if (!allowedRedirects.includes(requestedUrl.protocol)) {
            console.warn(`Disallowing redirect to ${url}`);
            ev.preventDefault();
        }
    });

    // Block opening any external applications.
    mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback, details) => {
        if (permission === 'openExternal') {
            console.warn(`Disallowing opening ${(details as { externalURL?: string; }).externalURL}`);
            callback(false);

            return;
        }

        callback(true);
    });

    // NOTE: Popups configuration and SDK handlers are set up on the
    // meetingWindow (not the launcher) because the conference iframe
    // only exists there. See the 'open-meeting-window' handler below.

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.once('ready-to-show', () => {
        const initialUrl = getProtocolUrl(process.argv);

        if (!initialUrl) {
            mainWindow?.show();
        }
    });

    /**
     * When someone tries to enter something like jitsi-meet://test
     *  while app is closed
     * it will trigger this event below
     */
    handleProtocolCall(getProtocolUrl(process.argv));
}

function getProtocolUrl(argv: string[]): string | undefined {
    console.log('process.env.ROOM_URL', process.env.ROOM_URL);
    if (process.env.ROOM_URL) {
        return process.env.ROOM_URL;
    }

    console.log('argv', argv);
    const roomUrlArg = argv.find(arg => arg.startsWith('--room-url='));

    if (roomUrlArg) {
        return roomUrlArg.substring('--room-url='.length);
    }

    return [ ...argv ].reverse().find(arg =>
        arg.startsWith(appProtocolSurplus)
        || arg.startsWith('http://')
        || arg.startsWith('https://')
    );
}

/**
 * Handler for application protocol links to initiate a conference.
 *
 * @param {string} fullProtocolCall - The protocol call (e.g. jitsi-meet://test).
 * @returns {void}
 */
function handleProtocolCall(fullProtocolCall?: string) {
    // don't touch when something is bad
    if (
        !fullProtocolCall
        || fullProtocolCall.trim() === ''
    ) {
        return;
    }

    let inputURL = fullProtocolCall;

    if (fullProtocolCall.startsWith(appProtocolSurplus)) {
        inputURL = fullProtocolCall.replace(appProtocolSurplus, '');
    } else if (!fullProtocolCall.startsWith('http://') && !fullProtocolCall.startsWith('https://')) {
        return;
    }

    if (meetingWindow) {
        meetingWindow.webContents.send('protocol-data-msg', inputURL);

        return;
    }

    if (app.isReady() && mainWindow === null) {
        createJitsiMeetWindow();
    }

    protocolDataForFrontApp = inputURL;

    if (rendererReady && mainWindow) {
        mainWindow
            .webContents
            .send('protocol-data-msg', inputURL);
    }
}

/**
 * Force Single Instance Application.
 * Handle this on darwin via LSMultipleInstancesProhibited in Info.plist as below does not work on MAS
 */
const gotInstanceLock = process.platform === 'darwin' ? true : app.requestSingleInstanceLock();

if (!gotInstanceLock) {
    app.quit();
    process.exit(0);
}

/**
 * Run the application.
 */

app.on('activate', () => {
    if (mainWindow === null) {
        createJitsiMeetWindow();
    }
});

app.on('certificate-error',
    // eslint-disable-next-line max-params
    (event, webContents, url, error, certificate, callback) => {
        if (isDev || process.env.IGNORE_CERTIFICATE_ERRORS === 'true' || process.argv.includes('--ignore-certificate-errors')) {
            event.preventDefault();
            callback(true);
            return;
        }

        if (process.env.MTLS_CA_CERT) {
            try {
                const caCert = new crypto.X509Certificate(fs.readFileSync(process.env.MTLS_CA_CERT));
                let serverCert;
                // 'certificate.data' might be a PEM string or a DER buffer depending on the Electron version
                if (typeof certificate.data === 'string' && !certificate.data.includes('-----BEGIN CERTIFICATE-----')) {
                    // Fallback if it's actually DER data as a string (legacy)
                    serverCert = new crypto.X509Certificate(Buffer.from(certificate.data, 'binary'));
                } else {
                    serverCert = new crypto.X509Certificate(certificate.data);
                }

                if (serverCert.verify(caCert.publicKey)) {
                    event.preventDefault();
                    callback(true);
                    return;
                }
            } catch (e) {
                console.error('Failed to verify custom CA:', e);
            }
        }

        callback(false);
    }
);

app.on('select-client-certificate', (event, webContents, url, list, callback) => {
    if (process.env.MTLS_CLIENT_CERT && list.length > 0) {
        event.preventDefault();
        callback(list[0]);
    }
});

app.on('ready', () => {
    if (process.env.MTLS_CLIENT_CERT) {
        app.importCertificate({
            certificate: process.env.MTLS_CLIENT_CERT,
            password: process.env.MTLS_CLIENT_PASS || ''
        }, (result) => {
            if (result === 0) {
                console.log('Successfully imported client certificate.');
            } else {
                console.error(`Failed to import client certificate, net::ERR code: ${result}`);
            }
        });
    }
    createJitsiMeetWindow();
});

app.on('second-instance', (event, commandLine) => {
    /**
     * If someone creates second instance of the application, set focus on
     * existing window.
     */
    const url = getProtocolUrl(commandLine);

    if (!url && mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
    }

    if (meetingWindow) {
        meetingWindow.isMinimized() && meetingWindow.restore();
        meetingWindow.focus();
    } else if (mainWindow) {
        mainWindow.isMinimized() && mainWindow.restore();
        mainWindow.focus();
    }

    /**
     * This is for windows [win32]
     * so when someone tries to enter something like jitsi-meet://test
     * while app is opened it will trigger protocol handler.
     */
    handleProtocolCall(url);
});

app.on('window-all-closed', () => {
    app.quit();
});

// remove so we can register each time as we run the app.
app.removeAsDefaultProtocolClient(config.appProtocolPrefix);

// If we are running a non-packaged version of the app && on windows
if (isDev && process.platform === 'win32') {
    // Set the path of electron.exe and your app.
    // These two additional parameters are only available on windows.
    app.setAsDefaultProtocolClient(
        config.appProtocolPrefix,
        process.execPath,
        [ path.resolve(process.argv[1]) ]
    );
} else {
    app.setAsDefaultProtocolClient(config.appProtocolPrefix);
}

/**
 * This is for mac [darwin]
 * so when someone tries to enter something like jitsi-meet://test
 * it will trigger this event below
 */
app.on('open-url', (event, data) => {
    event.preventDefault();
    handleProtocolCall(data);
});

/**
 * This is to notify main.js [this] that front app is ready to receive messages.
 * Called by BOTH the launcher and the meeting window on componentDidMount.
 */
ipcMain.on('renderer-ready', event => {
    // Launcher window — existing behaviour unchanged.
    if (mainWindow && event.sender.id === mainWindow.webContents.id) {
        rendererReady = true;
        if (protocolDataForFrontApp) {
            mainWindow
                .webContents
                .send('protocol-data-msg', protocolDataForFrontApp);
        }


    }

    // Meeting window is ready.
});

/**
 * Handle opening external links in the main process.
 */
ipcMain.on('jitsi-open-url', (event, someUrl) => {
    openExternalLink(someUrl);
});

/**
 * Restore the meeting window (e.g. from PiP).
 */
ipcMain.on('restore-meeting-window', () => {
    if (meetingWindow) {
        if (meetingWindow.isMinimized()) {
            meetingWindow.restore();
        }
        meetingWindow.focus();
    }
});

/**
 * Asks the user whether a remote control session may start.
 *
 * The request that gets here reaches the meeting window as a postMessage from
 * the conference iframe, so it carries no identity that can be trusted: any page
 * loaded in that iframe can send it, and Jitsi Meet's own in-page consent UI
 * runs inside exactly the frame an attacker controls. The prompt is therefore a
 * native, modal dialog owned by the main process — web content can neither
 * render, click nor dismiss it — and nothing is executed until the user allows
 * it here.
 *
 * @returns {Promise<boolean>} Whether the user allowed the session.
 */
async function requestRemoteControlConsent(): Promise<boolean> {
    if (!meetingWindow) {
        return false;
    }

    const { response } = await dialog.showMessageBox(meetingWindow, {
        type: 'warning',
        buttons: [ t('remoteControl.deny'), t('remoteControl.allow') ],
        defaultId: 0,
        cancelId: 0,
        message: t('remoteControl.message'),
        detail: t('remoteControl.detail')
    });

    return response === 1;
}

/**
 * Open the meeting in Window 2.
 * If a meeting window already exists, focus it and navigate to the new conference.
 * Otherwise create a new one.
 */
ipcMain.on('open-meeting-window', (event, conference) => {
    if (meetingWindow) {
        meetingWindow.focus();
        meetingWindow.webContents.send('navigate-to-conference', conference);

        return;
    }

    const basePath = isDev ? rootDir : app.getAppPath();
    const meetingURL = URL.format({
        pathname: path.resolve(basePath, './build/meeting.html'),
        protocol: 'file:',
        slashes: true
    });

    const windowOpenHandler = ({ url, frameName }: { frameName: string; url: string; }) => {
        const target = getPopupTarget(url, frameName);

        if (!target || target === 'browser') {
            openExternalLink(url);

            return { action: 'deny' };
        }

        if (target === 'electron') {
            return { action: 'allow' };
        }

        return { action: 'deny' };
    };

    meetingWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        icon: path.resolve(basePath, './resources/icon.png'),
        resizable: true,
        show: false,
        webPreferences: {
            enableBlinkFeatures: 'WebAssemblyCSP',
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.resolve(basePath, './build/preload.js'),
            sandbox: true
        }
    });

    meetingWindow.loadURL(meetingURL);

    // Force hide the Jitsi watermark by injecting CSS directly into the conference iframe
    meetingWindow.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
        if (!isMainFrame && meetingWindow) {
            const zoomLevel = process.env.ZOOM_LEVEL || '1.0';
            const code = `
                if (!document.getElementById('hide-watermark-style')) {
                    var style = document.createElement('style');
                    style.id = 'hide-watermark-style';
                    style.innerHTML = \`
                        .watermark, .leftwatermark { display: none !important; visibility: hidden !important; width: 0 !important; height: 0 !important; opacity: 0 !important; pointer-events: none !important; }
                        
                        /* Resize all main buttons in Jitsi Meet */
                        .toolbox-button, .action-btn, .primary-btn, .secondary-btn, .button {
                            zoom: ${zoomLevel} !important;
                        }
                    \`;
                    if (document.head) {
                        document.head.appendChild(style);
                    }
                }
            `;
            try {
                meetingWindow.webContents.mainFrame.frames.forEach(frame => {
                    if (frame !== meetingWindow?.webContents.mainFrame) {
                        frame.executeJavaScript(code).catch(() => {});
                    }
                });
            } catch (err) {
                console.warn('Failed to inject watermark CSS', err);
            }
        }
    });
    meetingWindow.webContents.once('did-finish-load', () => {
        meetingWindow?.webContents.send('navigate-to-conference', conference);
    });

    // SDK setup — these need the window that hosts the conference iframe.
    initPopupsConfigurationMain(meetingWindow, windowOpenHandler);
    setupPictureInPictureMain(meetingWindow);
    setupPowerMonitorMain(meetingWindow);
    setupScreenSharingMain(meetingWindow, config.appName, pkgJson.build.appId);
    setupRemoteControlMain(meetingWindow, { requestConsent: requestRemoteControlConsent });

    // Block redirects — same protection as the launcher window.
    meetingWindow.webContents.addListener('will-redirect', (ev, url) => {
        const allowedProtocols = [ 'http:', 'https:', 'ws:', 'wss:' ];
        const requestedUrl = new URL.URL(url);

        if (!allowedProtocols.includes(requestedUrl.protocol)) {
            console.warn(`Disallowing redirect to ${url}`);
            ev.preventDefault();
        }
    });

    // Closing the meeting window must NOT quit the app — launcher stays open.
    meetingWindow.on('closed', () => {
        meetingWindow = null;
        if (mainWindow && !mainWindow.isVisible()) {
            mainWindow.close();
        }
    });

    meetingWindow.once('ready-to-show', () => {
        meetingWindow?.show();
        setTimeout(() => meetingWindow?.maximize(), 100);
    });
});

/**
 * Close the meeting window — called by renderer when End Call is clicked.
 */
ipcMain.on('close-meeting-window', () => {
    if (meetingWindow) {
        meetingWindow.close();
    }
});
