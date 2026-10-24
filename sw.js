/* PoPoT – service worker (MODULE 3 – PARTIE 1 : ouverture sans connexion)

   Rôle : garder sur le téléphone une copie de l'application (index.html, manifest, icônes) ET de la bibliothèque
   de la base de données (script supabase-js hébergé sur le CDN jsDelivr), pour que PoPoT s'ouvre sans réseau.

   Stratégie : « le réseau d'abord » (network-first).
     - en ligne, la version la plus récente est téléchargée à chaque ouverture, rangée en réserve, et c'est elle qu'on affiche :
       les mises à jour arrivent toutes seules, rien à faire pour la famille ;
     - si le réseau est absent, en panne, ou plus lent que NET_TIMEOUT, on sert la copie gardée ;
     - on ne range jamais une réponse d'erreur ni une page qui n'est pas PoPoT (ex. page d'un Wi-Fi public).
   Les appels à la base (supabase.co), les photos et tout le reste ne sont PAS touchés : ils passent directement.

   Interrupteur de sécurité : ouvrir l'application avec ?nosw=1 contourne entièrement ce fichier
   (voir le script en tête de index.html, qui désinstalle aussi le service worker et vide les réserves). */
'use strict';

const VERSION = '4.0';
const CACHE = 'popot-shell-' + VERSION;
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SCOPE = self.registration.scope;                       // ex. https://nom.github.io/popot/
const PAGE_KEY = new URL('index.html', SCOPE).href;          // toutes les ouvertures de l'application utilisent la même copie
const SHELL = ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const NET_TIMEOUT = 1500;   // page : au-delà, on affiche la copie gardée (le téléphone est alors prêt en moins de 3 s même sur un réseau qui rame)

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // l'application elle-même : obligatoire (si un fichier manque, l'installation échoue et l'ancienne version continue)
    for (const f of SHELL) {
      const url = new URL(f, SCOPE).href;
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error('Téléchargement impossible : ' + f);
      await cache.put(f === 'index.html' ? PAGE_KEY : url, res);
    }
    // la bibliothèque de la base : au mieux (sera aussi rangée à la première ouverture si ce n'est pas possible maintenant)
    try {
      let res;
      try { res = await fetch(new Request(CDN, { mode: 'cors', cache: 'reload' })); }
      catch (e) { res = await fetch(new Request(CDN, { mode: 'no-cors', cache: 'reload' })); }
      if (res.ok || res.type === 'opaque') await cache.put(CDN, res);
    } catch (e) { /* pas grave */ }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // ménage : on supprime les réserves des anciennes versions
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => /^popot-/.test(k) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.searchParams.has('nosw')) return;                // interrupteur de sécurité : page chargée normalement, sans nous
    event.respondWith(networkFirst(event, PAGE_KEY, true));
    return;
  }
  if (url.href === CDN) { event.respondWith(staleWhileRevalidate(event, CDN)); return; }
  if (url.origin === location.origin && url.href.startsWith(SCOPE) && !/\/sw\.js$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, url.origin + url.pathname));
    return;
  }
  // tout le reste (base de données, photos…) : le navigateur s'en occupe, comme sans service worker
});

// vrai si la réponse est bien la page PoPoT (et pas, par exemple, la page d'accueil d'un Wi-Fi public)
async function isApp(res) {
  try { return /<title>PoPoT<\/title>/.test(await res.text()); } catch (e) { return false; }
}

async function networkFirst(event, key, isPage) {
  const cache = await caches.open(CACHE);
  // « no-cache » : le navigateur vérifie toujours auprès du serveur (sinon l'hébergeur peut faire garder une page 10 minutes)
  const netReq = isPage ? new Request(event.request.url, { cache: 'no-cache' }) : new Request(event.request, { cache: 'no-cache' });
  const fresh = fetch(netReq).then(async res => {
    const good = isPage ? (res.ok && await isApp(res.clone())) : (res.ok || res.type === 'opaque');
    if (good) await cache.put(key, res.clone());
    return { res: res, good: good };
  });
  event.waitUntil(fresh.catch(() => {}));                     // la mise à jour de la réserve se termine même si on a déjà répondu
  try {
    const out = await Promise.race([fresh, new Promise(r => setTimeout(() => r(null), NET_TIMEOUT))]);
    if (out && out.good) return out.res;
    const hit = await cache.match(key);
    if (hit) return hit;                                     // réseau trop lent ou réponse douteuse : copie gardée
    return out ? out.res : (await fresh).res;                // pas de copie : on attend le réseau
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;                                     // réseau absent : copie gardée
    throw e;
  }
}

// bibliothèque de la base et petits fichiers (icônes, manifeste) : on sert tout de suite la copie gardée (rapide, même sur un réseau qui rame)
// et on la remet à jour en arrière-plan. Sans copie gardée, on attend le réseau.
async function staleWhileRevalidate(event, key) {
  // on lit la réserve sans la créer : si elle a été effacée (interrupteur ?nosw=1 ou Réglages), elle n'est pas recréée par un simple fichier
  const hit = await caches.match(key, { cacheName: CACHE });
  const fresh = fetch(new Request(event.request, { cache: 'no-cache' })).then(async res => {
    if ((res.ok || res.type === 'opaque') && await caches.has(CACHE)) { const c = await caches.open(CACHE); await c.put(key, res.clone()); }
    return res;
  });
  event.waitUntil(fresh.catch(() => {}));
  return hit || fresh;
}
