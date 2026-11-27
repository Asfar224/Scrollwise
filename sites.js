// Sites the cat watches. Add a `path` regex to watch only part of a site.
const SITES = [
  { name: 'Instagram', hosts: ['instagram.com'] },
  { name: 'YouTube Shorts', hosts: ['youtube.com'], path: /^\/shorts(\/|$)/ },
  { name: 'TikTok', hosts: ['tiktok.com'] },
  { name: 'X', hosts: ['x.com', 'twitter.com'] },
  { name: 'Reddit', hosts: ['reddit.com'] },
  { name: 'Facebook', hosts: ['facebook.com'] },
];

// Matches built-in sites first, then any the person added (`extra`).
function siteFor(url, extra = []) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  return (
    [...SITES, ...extra].find(
      (site) =>
        site.hosts.some((h) => host === h || host.endsWith('.' + h)) &&
        (!site.path || site.path.test(parsed.pathname))
    ) || null
  );
}

// A site someone typed in: the bare host is both its name and what it matches.
const customSite = (host) => ({ name: host, hosts: [host], custom: true });

/*
 * Turns what someone typed ("Pinterest.com", "https://www.reddit.com/r/cats") into a
 * bare host like "pinterest.com", or null if it doesn't look like a website.
 */
function hostFrom(text) {
  const trimmed = String(text).trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : 'https://' + trimmed);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.replace(/^www\./, '').replace(/\.$/, '');
  // Needs a dot and a real top-level part, e.g. "pinterest.com", not "pinterest".
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : null;
}

module.exports = { SITES, siteFor, customSite, hostFrom };
