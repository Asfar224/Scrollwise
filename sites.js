// Sites the cat watches. Add a `path` regex to watch only part of a site.
const SITES = [
  { name: 'Instagram', hosts: ['instagram.com'] },
  { name: 'YouTube Shorts', hosts: ['youtube.com'], path: /^\/shorts(\/|$)/ },
  { name: 'TikTok', hosts: ['tiktok.com'] },
  { name: 'X', hosts: ['x.com', 'twitter.com'] },
  { name: 'Reddit', hosts: ['reddit.com'] },
  { name: 'Facebook', hosts: ['facebook.com'] },
];

function siteFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  return (
    SITES.find(
      (site) =>
        site.hosts.some((h) => host === h || host.endsWith('.' + h)) &&
        (!site.path || site.path.test(parsed.pathname))
    ) || null
  );
}

module.exports = { SITES, siteFor };
