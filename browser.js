/*
 * Talks to the browser: which tab is in front, where it is on screen, and closing it.
 * Uses AppleScript, so macOS asks once for permission to control each browser.
 */
const { execFile } = require('child_process');
const { systemPreferences } = require('electron');

// App name -> which AppleScript dialect it speaks.
const BROWSERS = {
  'Google Chrome': 'chrome',
  'Brave Browser': 'chrome',
  'Microsoft Edge': 'chrome',
  Chromium: 'chrome',
  Vivaldi: 'chrome',
  Arc: 'arc',
  Safari: 'safari',
  Firefox: 'firefox',
  'Firefox Developer Edition': 'firefox',
  'Firefox Nightly': 'firefox',
  LibreWolf: 'firefox',
  Zen: 'firefox',
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
  // Arc speaks Chrome's dialect but has no tab index, and tab ids are text.
  arc: (app) => `
    set sep to (ASCII character 9)
    tell application "${app}"
      if (count of windows) is 0 then return ""
      set w to front window
      set t to active tab of w
      set b to {0, 0, 0, 0}
      try
        set b to bounds of w
      end try
      return "" & (id of t) & sep & 1 & sep & (count of tabs of w) & sep & (item 1 of b) & sep & (item 2 of b) & sep & (item 3 of b) & sep & (item 4 of b) & sep & (URL of t)
    end tell`,
};

/*
 * Firefox has no AppleScript for tabs, so read the address bar through the
 * Accessibility API instead. Prints JSON: { url, x, y, w, h } or {} if not found.
 */
const FIREFOX_READ = `
function run(argv) {
  const se = Application('System Events');
  let proc = se.processes.byName(argv[0]);
  if (!proc.exists()) proc = se.processes.whose({ frontmost: true })[0];
  // Firefox only builds its accessibility tree once something asks for it. Leave it on:
  // switching it off and on every second makes the window stutter.
  try { const eui = proc.attributes.byName('AXEnhancedUserInterface'); if (!eui.value()) eui.value = true; } catch (e) {}
  function urlIn(el, depth, inToolbar) {
    if (depth > 10) return null;
    let kids;
    try { kids = el.uiElements(); } catch (e) { return null; }
    for (const k of kids) {
      let role = '';
      try { role = k.role(); } catch (e) { continue; }
      if (role === 'AXWebArea' || role === 'AXScrollArea') continue; // page content
      if (inToolbar && (role === 'AXTextField' || role === 'AXComboBox')) {
        let v = '';
        try { v = String(k.value() || ''); } catch (e) {}
        if (/^[^\\s]+\\.[^\\s]+/.test(v)) return v; // looks like an address, not a half-typed search
      }
      const found = urlIn(k, depth + 1, inToolbar || role === 'AXToolbar');
      if (found) return found;
    }
    return null;
  }
  const windows = proc.windows();
  for (const w of windows) {
    const url = urlIn(w, 0, false);
    if (url) {
      const [x, y] = w.position();
      const [width, height] = w.size();
      return JSON.stringify({ url, x, y, w: width, h: height });
    }
  }
  return '{}';
}`;

// The address bar often hides "https://", so put a scheme back before matching.
const withScheme = (url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url);

async function readFirefox(app) {
  // Without the permission macOS doesn't fail, it just shows no windows, so check first.
  accessibilityDenied = !systemPreferences.isTrustedAccessibilityClient(false);
  if (accessibilityDenied) return null;
  const { url, x, y, w, h } = JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FIREFOX_READ, app]));
  if (!url) return null;
  // No tab ids in Firefox; closing checks the address instead.
  return { app, kind: 'firefox', id: '', index: 1, count: 1, bounds: { x, y, width: w, height: h }, url: withScheme(url) };
}

const isPermissionError = (error) => /-1743|not authori[sz]ed/i.test(error.stderr || '');

/**
 * The tab the person is looking at, or null when no supported browser is in front.
 * Throws { permission: true } when macOS has denied control of the browser.
 */
async function getFrontTab() {
  const app = await frontApp();
  const kind = BROWSERS[app];
  if (!kind) return null;

  if (kind === 'firefox') {
    try {
      return await readFirefox(app);
    } catch (error) {
      if (isPermissionError(error)) throw Object.assign(error, { permission: true, app: 'System Events' });
      return null;
    }
  }

  let out;
  try {
    out = await osascript(READ[kind](app));
  } catch (error) {
    if (isPermissionError(error)) throw Object.assign(error, { permission: true, app });
    return null; // e.g. the front window has no tabs
  }
  if (!out) return null;

  const [id, index, count, left, top, right, bottom, ...url] = out.split('\t');
  return {
    app,
    kind,
    id, // Chrome and Arc report ids as text; Safari's is the tab index
    index: Number(index), // 1-based
    count: Number(count),
    bounds: { x: Number(left), y: Number(top), width: Number(right) - Number(left), height: Number(bottom) - Number(top) },
    url: url.join('\t'),
  };
}

/*
 * Finds the real on-screen rectangle of the front window's tabs through the
 * Accessibility API. Works on any Mac, screen size, window position or tab layout,
 * but needs Accessibility permission (System Settings > Privacy & Security).
 * Prints JSON: { tabs: [{x, y, w, h, selected}] } sorted left to right.
 */
const FIND_TABS = `
function run(argv) {
  const se = Application('System Events');
  let proc = se.processes.byName(argv[0]);
  if (!proc.exists()) proc = se.processes.whose({ frontmost: true })[0]; // e.g. Firefox's process is "firefox"
  // Chrome only builds its accessibility tree when asked, so switch it on for the lookup.
  const eui = proc.attributes.byName('AXEnhancedUserInterface');
  let wasOn = true;
  try { wasOn = eui.value(); if (!wasOn) eui.value = true; } catch (e) {}
  const tabs = [];
  function walk(el, depth) {
    if (depth > 12 || tabs.length) return;
    let kids;
    try { kids = el.uiElements(); } catch (e) { return; }
    for (const k of kids) {
      let role = '';
      try { role = k.role(); } catch (e) { continue; }
      if (role === 'AXWebArea' || role === 'AXScrollArea' || role === 'AXTextField') continue; // page content, never tabs
      if (role === 'AXTabGroup') {
        for (const t of k.uiElements()) {
          let r = '';
          try { r = t.role(); } catch (e) { continue; }
          if (r !== 'AXRadioButton' && r !== 'AXTab') continue;
          const [x, y] = t.position();
          const [w, h] = t.size();
          let selected = false;
          try { selected = Boolean(Number(t.value())); } catch (e) {}
          if (w > 0 && h > 0) tabs.push({ x, y, w, h, selected });
        }
        if (tabs.length) return;
      }
      walk(k, depth + 1);
    }
  }
  // Windows come front to back. In full screen the tab strip is a separate small window,
  // so look through each one and stop at the first that has tabs.
  for (let attempt = 0; attempt < 2 && !tabs.length; attempt++) {
    if (attempt) delay(0.4); // the tree may still be building
    const windows = proc.windows();
    for (let i = 0; i < windows.length && !tabs.length; i++) walk(windows[i], 0);
  }
  if (!wasOn) { try { eui.value = false; } catch (e) {} }
  tabs.sort((a, b) => a.x - b.x);
  return JSON.stringify({ tabs });
}`;

let accessibilityDenied = false;

// The active tab's real rectangle in screen points, or null if macOS won't say.
async function tabRect(tab) {
  // Without the permission macOS doesn't fail, it just shows no windows, so check first.
  accessibilityDenied = !systemPreferences.isTrustedAccessibilityClient(false);
  if (accessibilityDenied) return null;
  try {
    const out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FIND_TABS, tab.app]);
    const { tabs } = JSON.parse(out);
    if (!tabs.length) return null;
    return tabs.find((t) => t.selected) ?? tabs[tab.index - 1] ?? null;
  } catch {
    return null; // window closed mid-lookup, or a layout we don't recognise
  }
}

/**
 * Where the cat should land: x is the middle of the tab, y is the line its feet stand
 * on, just above the tab's bottom edge so it runs along the tab row. Screen points.
 * Uses the real tab position when Accessibility is allowed, otherwise an estimate
 * from the window frame and each browser's standard tab strip layout.
 */
async function tabTarget(tab) {
  const rect = await tabRect(tab);
  if (rect) return { x: rect.x + rect.w / 2, y: rect.y + rect.h - 4 }; // feet just inside the tab's bottom edge

  const { x, y, width } = tab.bounds;
  if (!width) return null; // the browser wouldn't say where its window is
  if (tab.kind === 'arc') {
    // Tabs live in the left sidebar; stand on the top of it, by the address field.
    return { x: x + 130, y: y + 48 };
  }
  if (tab.kind === 'safari') {
    // Separate tab bar under the toolbar; with one tab there is no bar, so stand on the toolbar.
    if (tab.count <= 1) return { x: x + width / 2, y: y + 48 };
    const tabWidth = width / tab.count;
    return { x: x + (tab.index - 0.5) * tabWidth, y: y + 82 };
  }
  // Chromium browsers and Firefox: tabs start right of the window buttons, at the top of the window.
  const firefox = tab.kind === 'firefox';
  const LEFT = firefox ? 110 : 78; // Firefox has a Firefox View button first
  const RIGHT = 90; // new-tab and tab list buttons
  const MAX_TAB = firefox ? 225 : 256;
  const tabWidth = Math.min(MAX_TAB, (width - LEFT - RIGHT) / tab.count);
  return { x: x + LEFT + (tab.index - 0.5) * tabWidth, y: y + 38 };
}

// Firefox can't close a tab by script, so press ⌘W, but only if it's still in front on the same page.
async function closeFirefoxTab(tab) {
  if ((await frontApp()) !== tab.app) return 'moved';
  const now = await readFirefox(tab.app);
  if (!now || now.url !== tab.url) return 'moved';
  await osascript('tell application "System Events" to keystroke "w" using command down');
  return 'closed';
}

// Closes the tab, but only if it is still the one in front.
async function closeTab(tab) {
  if (!BROWSERS[tab.app]) return false;
  const id = String(tab.id);
  if (!/^[\w-]*$/.test(id)) return false; // ids go into the script, so only plain ones
  // Compare ids as text: Chrome and Arc report them as text, and a number never equals it.
  const script =
    tab.kind === 'safari'
      ? `tell application "${tab.app}" to close current tab of front window`
      : `tell application "${tab.app}"
           set t to active tab of front window
           if ((id of t) as text) is "${id}" then
             close t
             return "closed"
           end if
           return "moved"
         end tell`;
  try {
    const out = tab.kind === 'firefox' ? await closeFirefoxTab(tab) : await osascript(script);
    if (out === 'moved') console.log(`Scrollwise: left ${tab.app} alone, a different tab is in front now`);
    return out !== 'moved';
  } catch (error) {
    console.error(`Scrollwise: couldn't close the ${tab.app} tab:`, (error.stderr || error.message).trim());
    return false;
  }
}

module.exports = { frontApp, getFrontTab, tabTarget, closeTab, needsAccessibility: () => accessibilityDenied };
