# Scrollwise

A menu bar app for macOS that stops doom scrolling with a cat. A small fluffy cat watches your browser, and when you've scrolled too long it runs along your tabs, pounces on the one you're on, and closes it.

Spend too long on Instagram, YouTube Shorts, TikTok, X, Reddit, or Facebook and the cat leans in from the edge of the screen to warn you. Ignore it, and the cat runs along the tab row, wiggles, hops onto your tab, and the tab closes.

Built with Electron and plain JavaScript.

## Run it

```bash
npm install
```

```bash
npm start
```

A cat icon appears in the menu bar. macOS asks for two permissions. While you run it with `npm start`, the prompts name Electron or your terminal instead of Scrollwise.

- **Accessibility**, asked on first launch. It lets the cat find exactly where your tab is on screen. If you skip it, the menu shows **Allow Accessibility for Scrollwise…** to turn it on later.
- **Control of your browser** (Automation), asked the first time a supported browser is in front. This is how Scrollwise reads the current tab and closes it.

To try it out:

- **Preview the cat** in the menu plays the whole animation without closing anything.
- **Scroll limit → 1 min** is the quickest way to test the real thing.

Works with Chrome, Brave, Edge, Vivaldi, and Safari.

## How it works

- **One shared budget.** All watched sites count toward a single timer (10 minutes by default). The time left shows next to the menu bar icon.
- **Only the tab in front counts.** Five minutes away from every watched site starts a new session.
- **Warning.** In the last 20% of the budget (at most the last 2 minutes), the cat leans in from the left edge with a countdown.
- **Pounce.** At the limit the cat runs along the tab row to your tab and lands on it. The tab closes on impact.
- **Finds the real tab.** The tab's position comes from the Accessibility API, so the cat lands on it on any screen size, window position, or full-screen layout. In full screen the cat stays low enough that it's never cut off at the top.
- **Cooldown.** Watched sites stay closed for 5 minutes. Opening one gets it closed again.
- **YouTube.** Only `/shorts` is watched.

## Files

| File | Role |
| --- | --- |
| `main.js` | App shell: the see-through overlay window, menu bar icon, timer loop |
| `browser.js` | Asks the browser for the front tab (AppleScript), finds where the tab is on screen (Accessibility), closes it |
| `sites.js` | The watched sites |
| `preload.js` | The two functions the overlay page is allowed to call |
| `renderer/cat.js` | The cat: SVG drawing, run cycle, and the pounce sequence |
| `renderer/overlay.html`, `overlay.css` | The overlay page the cat lives in |

## Known rough edges

- **Without Accessibility** the tab position is estimated from the window frame. That's close for normal windows but off in full screen and with pinned or vertical tabs.
- **Videos keep playing** until the tab closes.
- **Arc and Firefox** are not supported yet.

## Ideas

- Escalating moods for repeat offences, and "five more minutes" bargaining
- A settings window for custom sites and per-site limits
- Let the cat wander the desktop when you are behaving
