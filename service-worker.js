const CACHE = 'medialib-shell-v11';
const SHELL = ['./','./index.html','./style.css','./archive.js','./app.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
// Stale-while-revalidate: open instantly (and offline) from the cache, while
// fetching the latest app files in the background so a new version pushed to
// GitHub Pages shows up on the next launch without bumping anything by hand.
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    const cached=await cache.match(request,{ignoreSearch:true});
    const network=fetch(request,{cache:'no-cache'}).then(response=>{if(response.ok)cache.put(request,response.clone());return response;}).catch(()=>null);
    if(cached){event.waitUntil(network);return cached;}
    return (await network)||(await cache.match('./index.html'))||Response.error();
  }));
});
