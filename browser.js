/*
 * Talks to the browser: which tab is in front, where it is on screen, and closing it.
 * Uses AppleScript, so macOS asks once for permission to control each browser.
 */
const { execFile } = require('child_process');

// App name -> which AppleScript dialect it speaks.
const BROWSERS = {
  'Google Chrome': 'chrome',
  'Brave Browser': 'chrome',
  'Microsoft Edge': 'chrome',
  Chromium: 'chrome',
  Vivaldi: 'chrome',
  Safari: 'safari',
};

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 4000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve(String(stdout).trim());
    });
  });
}

const osascript = (script) => run('/usr/bin/osascript', ['-e', script]);

// Name of the app in front. Needs no permission.
async function frontApp() {
  try {
    // First line looks like: "Google Chrome" ASN:0x0-0x1a2b3c: (in front)
    const out = await run('/bin/sh', ['-c', 'lsappinfo info "$(lsappinfo front)"']);
    return /^"(.*)" ASN:/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

const READ = {
  chrome: (app) => `
    set sep to (ASCII character 9)
    tell application "${app}"
      if (count of windows) is 0 then return ""
      set w to front window
      set t to active tab of w
      set b to bounds of w
      return "" & (id of t) & sep & (active tab index of w) & sep & (count of tabs of w) & sep & (item 1 of b) & sep & (item 2 of b) & sep & (item 3 of b) & sep & (item 4 of b) & sep & (URL of t)
    end tell`,
  safari: (app) => `
    set sep to (ASCII character 9)
    tell application "${app}"
      if (count of windows) is 0 then return ""
      set w to front window
      set t to current tab of w
      set b to bounds of w
      return "" & (index of t) & sep & (index of t) & sep & (count of tabs of w) & sep & (item 1 of b) & sep & (item 2 of b) & sep & (item 3 of b) & sep & (item 4 of b) & sep & (URL of t)
    end tell`,
};

/**
 * The tab the person is looking at, or null when no supported browser is in front.
 * Throws { permission: true } when macOS has denied control of the browser.
 */
async function getFrontTab() {
  const app = await frontApp();
  const kind = BROWSERS[app];
  if (!kind) return null;

  let out;
  try {
    out = await osascript(READ[kind](app));
  } catch (error) {
    if (/-1743|not authori[sz]ed/i.test(error.stderr || '')) throw Object.assign(error, { permission: true, app });
    return null; // e.g. the front window has no tabs
  }
  if (!out) return null;

  const [id, index, count, left, top, right, bottom, ...url] = out.split('\t');
  return {
    app,
    kind,
    id: Number(id),
    index: Number(index), // 1-based
    count: Number(count),
    bounds: { x: Number(left), y: Number(top), width: Number(right) - Number(left), height: Number(bottom) - Number(top) },
    url: url.join('\t'),
  };
}

/**
 * Where the cat should land: the middle of the tab, with y on the line its feet stand on.
 * Screen coordinates. AppleScript can't report a tab's real position, so this is
 * worked out from the window and the usual tab strip layout. Tune the numbers here.
 */
function tabTarget(tab) {
  const { x, y, width } = tab.bounds;
  if (tab.kind === 'safari') {
    // Safari's tab bar sits under the toolbar and spans the window; one tab means no bar.
    if (tab.count <= 1) return { x: x + width / 2, y: y + 52 };
    const tabWidth = width / tab.count;
    return { x: x + (tab.index - 0.5) * tabWidth, y: y + 80 };
  }
  const LEFT = 88; // window buttons
  const RIGHT = 56; // new-tab button and tab search
  const MAX_TAB = 240;
  const tabWidth = Math.min(MAX_TAB, (width - LEFT - RIGHT) / tab.count);
  return { x: x + LEFT + (tab.index - 0.5) * tabWidth, y: y + 40 };
}

// Closes the tab, but only if it is still the one in front.
async function closeTab(tab) {
  if (!BROWSERS[tab.app] || !Number.isInteger(tab.id)) return;
  const script =
    tab.kind === 'safari'
      ? `tell application "${tab.app}" to close current tab of front window`
      : `tell application "${tab.app}"
           set t to active tab of front window
           if (id of t) is ${tab.id} then close t
         end tell`;
  try {
    await osascript(script);
  } catch {
    // The tab or window went away on its own.
  }
}

module.exports = { frontApp, getFrontTab, tabTarget, closeTab };
