# Pounce

A menu bar app for macOS. A small fluffy cat watches your browser and closes the tab when you doom scroll too long.

Spend too long on Instagram, YouTube Shorts, TikTok, X, Reddit, or Facebook and the cat leans in from the edge of the screen to warn you. Ignore it, and the cat runs along the tab bar, wiggles, hops onto your tab, and the tab closes.

Built with Electron and plain JavaScript.

## Run it

```bash
npm install
```

```bash
npm start
```

A cat icon appears in the menu bar. The first time a supported browser is in front, macOS asks whether Pounce may control it. Say yes: that is how it reads the current tab and closes it. While you run it with `npm start`, the prompt names Electron or your terminal.

- **Preview the cat** in the menu plays the whole animation without closing anything.
- **Scroll limit → 1 min** is the quickest way to test the real thing.

Works with Chrome, Brave, Edge, Vivaldi, and Safari.

## How it works

- **One shared budget.** All watched sites count toward a single timer (10 minutes by default). The time left shows next to the menu bar icon.
- **Only the tab in front counts.** Five minutes away from every watched site starts a new session.
- **Warning.** In the last 20% of the budget (at most the last 2 minutes), the cat leans in from the left edge with a countdown.
- **Pounce.** At the limit the cat runs to your tab and lands on it; the tab closes on impact.
- **Cooldown.** Watched sites stay closed for 5 minutes. Opening one gets it closed again.
- **YouTube.** Only `/shorts` is watched.

## Files

| File | Role |
| --- | --- |
| `main.js` | App shell: the see-through overlay window, menu bar icon, timer loop |
| `browser.js` | Asks the browser for the front tab (AppleScript), estimates where the tab is, closes it |
| `sites.js` | The watched sites |
| `preload.js` | The two functions the overlay page is allowed to call |
| `renderer/cat.js` | The cat: SVG drawing, run cycle, and the pounce sequence |
| `renderer/overlay.html`, `overlay.css` | The overlay page the cat lives in |

## Known rough edges

- **Tab position is estimated.** AppleScript reports the window and the tab's index, not the tab's pixels, so `tabTarget()` in `browser.js` works it out from the usual tab strip layout. Pinned tabs, tab groups, and vertical tabs throw it off. The numbers to tune are at the top of that function.
- **Videos keep playing** until the tab closes.
- **Arc and Firefox** are not supported yet.

## Ideas

- Read the tab's real position through the Accessibility API
- Escalating moods for repeat offences, and "five more minutes" bargaining
- A settings window for custom sites and per-site limits
- Let the cat wander the desktop when you are behaving
