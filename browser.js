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

/*
 * Finds the real on-screen rectangle of the front window's tabs through the
 * Accessibility API. Works on any Mac, screen size, window position or tab layout,
 * but needs Accessibility permission (System Settings > Privacy & Security).
 * Prints JSON: { tabs: [{x, y, w, h, selected}] } sorted left to right.
 */
const FIND_TABS = `
function run(argv) {
  const proc = Application('System Events').processes.byName(argv[0]);
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
 * on, which is the top edge of the tab so it perches on the tab header. Screen points.
 * Uses the real tab position when Accessibility is allowed, otherwise an estimate
 * from the window frame and each browser's standard tab strip layout.
 */
async function tabTarget(tab) {
  const rect = await tabRect(tab);
  if (rect) return { x: rect.x + rect.w / 2, y: rect.y + 3 };

  const { x, y, width } = tab.bounds;
  if (tab.kind === 'safari') {
    // Separate tab bar under the toolbar; with one tab there is no bar, so stand on the toolbar.
    if (tab.count <= 1) return { x: x + width / 2, y: y + 6 };
    const tabWidth = width / tab.count;
    return { x: x + (tab.index - 0.5) * tabWidth, y: y + 54 };
  }
  // Chromium browsers: tabs start right of the window buttons, at the top of the window.
  const LEFT = 78;
  const RIGHT = 90; // new-tab and tab search buttons
  const MAX_TAB = 256;
  const tabWidth = Math.min(MAX_TAB, (width - LEFT - RIGHT) / tab.count);
  return { x: x + LEFT + (tab.index - 0.5) * tabWidth, y: y + 8 };
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

module.exports = { frontApp, getFrontTab, tabTarget, closeTab, needsAccessibility: () => accessibilityDenied };
