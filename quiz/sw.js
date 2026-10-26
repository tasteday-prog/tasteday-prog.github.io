'use strict';
const VERSION = 'e04e5907fae982d8ffea2fa42fb3162e013c974f006d51817cc67f7bdb41aa69';
const PREFIX = 'adminlaw-offline-';
// One atomic snapshot shared by old/new workers during a release transition.
const CACHE = PREFIX + 'v1';
const APP = new URL('./offline-' + VERSION + '.html', self.location.href).href;
const SCOPE = new URL('./', self.location.href);
const SAVED = new URL('./saved-quiz.html', self.location.href).href;

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
    const cache = await caches.open(CACHE);
    await cache.put(SAVED, response.clone());
    return response;
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
    const saved = await cache.match(SAVED);
    if (saved) return saved;
    // Rebuild offline storage if the browser evicted the cached page.
    try { return await downloadSnapshot(); } catch {}
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
