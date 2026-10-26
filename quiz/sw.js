'use strict';
const VERSION = 'd2dce53cc50e07fdd7973030189c10ba5749502895ec45afc548954c09f327b7';
const PREFIX = 'adminlaw-offline-';
// Share the activated snapshot: a navigation can briefly reach the prior worker
// even after clients.claim(). Keep immutable copies for download verification.
const CACHE = PREFIX + 'v1';
const APP = new URL('./offline-' + VERSION + '.html', self.location.href).href;
const SCOPE = new URL('./', self.location.href);
const SAVED = new URL('./saved-quiz.html', self.location.href).href;

self.addEventListener('message', event => {
  if (event.data?.type === 'QUIZ_VERSION') event.ports[0]?.postMessage({version: VERSION});
});

async function downloadSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    // Install a complete, verified snapshot before replacing the working version.
    const response = await fetch(APP, {cache: 'reload', signal: controller.signal});
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('Incomplete quiz download');
    }
    const bytes = await response.clone().arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== VERSION) throw new Error('Quiz download verification failed');
    const headers = new Headers(response.headers);
    headers.set('X-Quiz-Snapshot', VERSION);
    // Cache API stores this explicitly; the browser's navigation cache must not
    // reuse a response produced by a worker from the previous release.
    headers.set('Cache-Control', 'no-store');
    const snapshot = new Response(bytes, {status: response.status, headers});
    const cache = await caches.open(CACHE);
    await cache.put(APP, snapshot.clone());
    return snapshot;
  } finally { clearTimeout(timeout); }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await downloadSnapshot();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Only remove this quiz's old snapshots; never touch other apps or progress.
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    const cache = await caches.open(CACHE);
    const activated = await cache.match(APP);
    if (!activated) throw new Error('Verified snapshot missing during activation');
    await cache.put(SAVED, activated);
    const prior = (await cache.keys()).filter(r=>r.url !== APP && /\/offline-[a-f0-9]{64}\.html$/.test(new URL(r.url).pathname));
    // Keep two prior immutable snapshots for tabs still finishing a release transition.
    for (const request of prior.slice(0, Math.max(0, prior.length-2))) await cache.delete(request);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate' || url.origin !== SCOPE.origin ||
      ![SCOPE.pathname, SCOPE.pathname + 'index.html'].includes(url.pathname)) return;
  // Open immediately from the complete local copy, even on a stalled network.
  // The registration checks for updates separately; an update never flips a question.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(SAVED) || await cache.match(APP);
    if (saved) {
      const headers = new Headers(saved.headers);
      headers.set('X-Quiz-Worker', VERSION);
      headers.set('X-Quiz-App', APP);
      return new Response(await saved.arrayBuffer(), {status:saved.status, headers});
    }
    // Rebuild offline storage if the browser evicted the cached page.
    try {
      const snapshot = await downloadSnapshot();
      if (!await cache.match(SAVED)) await cache.put(SAVED, snapshot.clone());
      return snapshot;
    } catch {}
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(event.request, {signal: controller.signal});
        if (response.ok) return response;
      } finally { clearTimeout(timeout); }
    } catch {}
    return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>执法刷题</title><body style="font:18px/1.8 -apple-system,sans-serif;padding:24px;background:#f6f5ef;color:#242f2b"><h1>暂时无法打开题库</h1><p>请恢复网络后重试。已保存的答题进度不会因此清除。</p><button onclick="location.reload()" style="font:inherit;padding:12px 24px">重新打开</button></body></html>', {
      status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}
    });
  })());
});
