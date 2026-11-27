/*
 * Scrollwise: a menu bar app. A transparent, click-through window covers the screen;
 * the cat is drawn in it. Once a second we ask the browser which tab is in front,
 * count time on watched sites, and send the cat when the limit is reached.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const { SITES, siteFor } = require('./sites');
const browser = require('./browser');

const RESET_GAP_MS = 5 * 60 * 1000; // this long away from watched sites starts a new session
const COOLDOWN_MS = 5 * 60 * 1000; // watched sites stay closed this long after a pounce
const LIMIT_CHOICES = [1, 5, 10, 15, 20, 30];
const SMOKE = Boolean(process.env.SCROLLWISE_SMOKE); // start, report, quit; never touches a browser

let overlay = null;
let tray = null;
// skipped: names of sites the person unticked, so sites added later start out watched.
let state = { limitMinutes: 10, seconds: 0, lastActive: 0, blockedUntil: 0, skipped: [] };
let acting = null; // { tab, close } while the cat is mid-pounce
let actTimer = null;
let ticking = false;
let catOut = false; // the warning cat is on screen
let lastTab = null;
let needsPermission = null; // browser name macOS won't let us control
let needsAccessibility = false; // can't read real tab positions, so the cat estimates them
let peekY = 0;

const statePath = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) };
  } catch {
    // first run
  }
}

function saveState() {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // not worth crashing over
  }
}

const limitSeconds = () => state.limitMinutes * 60;
const isWatched = (site) => !state.skipped.includes(site.name);
const watchedSite = (url) => {
  const site = siteFor(url);
  return site && isWatched(site) ? site : null;
};
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const send = (channel, data) => overlay?.webContents.send('scrollwise:' + channel, data);

/* ---- overlay window ---- */

function createOverlay() {
  overlay = new BrowserWindow({
    ...screen.getPrimaryDisplay().bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    roundedCorners: false,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  overlay.setIgnoreMouseEvents(true); // clicks go straight through to whatever is underneath
  overlay.setAlwaysOnTop(true, 'screen-saver'); // above the menu bar and full-screen apps
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
}

// Put the overlay on whichever display the point is on; return the point in overlay coordinates.
function toOverlay(point) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  overlay.setBounds(display.bounds);
  const origin = overlay.getContentBounds();
  return { x: point.x - origin.x, y: point.y - origin.y };
}

/* ---- menu bar ---- */

function buildMenu() {
  const items = [];
  if (needsPermission) {
    items.push(
      { label: `Scrollwise can't see ${needsPermission}.`, enabled: false },
      { label: 'Allow it in System Settings → Privacy & Security → Automation', enabled: false },
      { type: 'separator' }
    );
  }
  if (needsAccessibility) {
    items.push(
      { label: 'Let the cat find your tabs exactly:', enabled: false },
      {
        label: 'Allow Accessibility for Scrollwise…',
        click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'),
      },
      { type: 'separator' }
    );
  }
  items.push(
    {
      label: 'Scroll limit',
      submenu: LIMIT_CHOICES.map((minutes) => ({
        label: `${minutes} min`,
        type: 'radio',
        checked: state.limitMinutes === minutes,
        click: () => {
          state.limitMinutes = minutes;
          saveState();
        },
      })),
    },
    {
      label: 'Watching',
      submenu: SITES.map((site) => ({
        label: site.name,
        type: 'checkbox',
        checked: isWatched(site),
        click: (item) => {
          state.skipped = item.checked
            ? state.skipped.filter((name) => name !== site.name)
            : [...state.skipped, site.name];
          saveState();
        },
      })),
    },
    { type: 'separator' },
    { label: 'Preview the cat', click: preview },
    { type: 'separator' },
    { label: 'Quit Scrollwise', role: 'quit' }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'icon32.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Scrollwise');
  buildMenu();
}

function showStatus() {
  const now = Date.now();
  let title = '';
  if (state.blockedUntil > now) title = ` ${clock((state.blockedUntil - now) / 1000)} nap`;
  else if (state.seconds > 0 && now - state.lastActive < RESET_GAP_MS) title = ` ${clock(limitSeconds() - state.seconds)}`;
  tray.setTitle(title);
}

/* ---- the loop ---- */

async function tick() {
  if (ticking || acting) return;
  ticking = true;
  try {
    let tab = null;
    try {
      tab = await browser.getFrontTab();
      if (needsPermission) {
        needsPermission = null;
        buildMenu();
      }
    } catch (error) {
      if (error.permission && needsPermission !== error.app) {
        needsPermission = error.app;
        buildMenu();
      }
    }
    lastTab = tab;
    if (acting) return; // a preview started while we were asking the browser

    if (!tab || !watchedSite(tab.url)) {
      if (catOut) {
        send('hide');
        catOut = false;
      }
      return;
    }

    const now = Date.now();
    if (state.blockedUntil > now) {
      const minutes = Math.ceil((state.blockedUntil - now) / 60000);
      act(tab, `Nope. Back in ${minutes} min.`, { close: true });
      return;
    }

    const stale = now - state.lastActive > RESET_GAP_MS;
    state.seconds = (stale ? 0 : state.seconds) + 1;
    state.lastActive = now;
    saveState();

    const limit = limitSeconds();
    const warnAt = Math.max(limit - 120, Math.round(limit * 0.8));
    if (state.seconds >= limit) {
      state.seconds = 0;
      state.lastActive = 0;
      state.blockedUntil = now + COOLDOWN_MS;
      saveState();
      act(tab, "Time's up. Paws off.", { close: true });
    } else if (state.seconds >= warnAt) {
      const left = limit - state.seconds;
      if (!catOut) peekY = toOverlay(await browser.tabTarget(tab)).y; // look the tab up once, not every second
      const local = { y: peekY };
      send('peek', { baseY: local.y, text: `psst… ${left >= 60 ? Math.ceil(left / 60) + ' min' : left + 's'} left` });
      catOut = true;
    } else if (catOut) {
      send('hide');
      catOut = false;
    }
  } finally {
    ticking = false;
    showStatus();
  }
}

// Send the cat to the tab. With close: true the tab is closed when it lands.
async function act(tab, text, { close }) {
  acting = { tab, close };
  catOut = false;
  const target = tab ? await browser.tabTarget(tab) : null;
  if (browser.needsAccessibility() !== needsAccessibility) {
    needsAccessibility = browser.needsAccessibility();
    buildMenu();
  }
  const display = screen.getPrimaryDisplay().bounds;
  const local = toOverlay(target ?? { x: display.x + 420, y: display.y + 90 });
  send('pounce', { tabX: local.x, baseY: local.y, text });
  actTimer = setTimeout(endAct, 20000); // never get stuck if the overlay goes quiet
}

function endAct() {
  clearTimeout(actTimer);
  acting = null;
}

function preview() {
  if (acting) return;
  act(lastTab, "Time's up. Paws off.", { close: false });
}

ipcMain.on('scrollwise:impact', () => {
  if (acting?.close && acting.tab) browser.closeTab(acting.tab);
});
ipcMain.on('scrollwise:done', endAct);

/* ---- startup ---- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    app.dock?.hide(); // menu bar only
    loadState();
    createOverlay();
    createTray();

    if (SMOKE) {
      overlay.webContents.once('did-finish-load', async () => {
        console.log('overlay loaded', JSON.stringify(overlay.getBounds()));
        console.log('front app:', await browser.frontApp());
        const fake = { app: 'Google Chrome', kind: 'chrome', index: 2, count: 4, bounds: { x: 0, y: 121, width: 1512, height: 861 } };
        console.log('tab target:', JSON.stringify(await browser.tabTarget(fake)), 'accessibility denied:', browser.needsAccessibility());
        setTimeout(() => app.quit(), 500);
      });
      return;
    }
    // Ask macOS once for Accessibility, which lets the cat read where the tabs really are.
    needsAccessibility = !systemPreferences.isTrustedAccessibilityClient(true);
    buildMenu();
    setInterval(tick, 1000);
  });
  app.on('window-all-closed', () => {}); // keep running in the menu bar
}
