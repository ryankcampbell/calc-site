/* Calculus — service worker.

   CACHE_VERSION IS STAMPED AT DEPLOY TIME by deploy.py, with a hash of
   index.html + style.css + app.js + manifest.webmanifest.  Do not hand-edit it
   and do not rely on the value below -- it is a placeholder in the source copy.

   Why: a browser installs a new worker only when THIS FILE's bytes change.
   While the version was hand-bumped, editing app.js shipped a fix that no
   installed app ever saw -- sw.js was unchanged, so no new worker installed and
   shellFirst() went on serving the cached app.js.  It revalidates in the
   background, so the fix appeared on the SECOND reload, which reads to a user
   as "I refreshed and nothing happened."  Stamping makes any shell edit
   invalidate the shell cache on the next publish, automatically.

   Strategy, per admin/reference/student_site_plan.md 4:
     index.json  network-first  — tiny, and new lessons must appear
     q/ and p/   cache-first    — 3-4 MB each, instant, offline
     the shell   cache-first, revalidated in the background

   Documents are requested as  q/foo.html?h=<hash>  by the page, so a changed
   document is a DIFFERENT URL.  Cache-first is therefore always correct: there
   is no stale-copy problem to detect and no hash bookkeeping in here.  Old
   versions are swept when a new hash for the same path is cached.
*/
const CACHE_VERSION = '5146f32dded1';
const SHELL = `calc-shell-${CACHE_VERSION}`;
const DOCS = 'calc-docs-v1';          // survives shell upgrades — documents are content-addressed
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'index.json',
                     'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting())
    .catch(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('calc-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isDoc = p => /\/(q|p)\/[^/]+\.(html|pdf)$/.test(p);

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/index.json')) { event.respondWith(networkFirst(req)); return; }
  if (isDoc(url.pathname))                  { event.respondWith(docFirst(req, url)); return; }
  event.respondWith(shellFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) cache.put(new Request(req.url), res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req.url) || await cache.match('index.json');
    if (!hit) return new Response('offline', { status: 503 });
    // Tell the page this manifest came from cache, so its status pill can be
    // honest about being offline instead of claiming "up to date".
    const h = new Headers(hit.headers);
    h.set('X-From-Cache', '1');
    return new Response(await hit.blob(), { status: 200, headers: h });
  }
}

async function shellFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

/* Cache-first for documents, with Range support so a cached PDF still opens in
   the browser's own viewer while offline — Chrome asks for byte ranges and a
   206 cannot be written to the Cache API, so it is reconstructed from the
   cached full body. */
async function docFirst(req, url) {
  const cache = await caches.open(DOCS);
  const key = url.pathname + url.search;
  let hit = await cache.match(key);

  if (!hit) {
    try {
      const res = await fetch(new Request(url.href, { cache: 'no-store' }));
      if (res && res.ok) {
        await cache.put(key, res.clone());
        sweep(cache, url.pathname, key);
        hit = res;
      } else {
        return res;
      }
    } catch (e) {
      const any = await cache.match(url.pathname, { ignoreSearch: true });
      if (any) hit = any; else return new Response('Offline and not saved yet.', { status: 504 });
    }
  }

  const range = req.headers.get('range');
  if (!range) return hit;
  const buf = await hit.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

/** Drop older versions of the same document once a new hash is cached. */
async function sweep(cache, pathname, keep) {
  for (const r of await cache.keys()) {
    const u = new URL(r.url);
    if (u.pathname === pathname && (u.pathname + u.search) !== keep) cache.delete(r);
  }
}
