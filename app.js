(() => {
  'use strict';
  const DB_NAME = 'medialib-local-library';
  const DB_VERSION = 2;
  const PAGE_SIZE = 60;
  const THUMB_MAX = 480;
  const IMAGE_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','tif','tiff','heic','heif','avif']);
  const VIDEO_EXT = new Set(['mp4','mov','m4v','webm','avi','mkv','3gp']);
  const AUDIO_EXT = new Set(['mp3','m4a','aac','wav','flac','ogg','opus']);
  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
  const state = { db:null, all:[], local:[], pc:{link:null,catalog:null,pending:[],status:'off',message:'',name:''}, collections:[], artistAvatars:{}, visible:[], filter:{type:'home'}, kind:'image', sort:'newest', query:'', selected:new Set(), expanded:new Set(), showAllTags:false, page:0, legacy:[], legacyByName:new Map(), byId:new Map(), thumbs:new Map(), thumbUrls:new Map(), thumbQueue:[], thumbQueued:new Set(), thumbFailed:new Set(), thumbWorkers:0, thumbObserver:null, detailIndex:-1, objectUrls:new Map(), avatarLookups:new Set(), avatarQueue:Promise.resolve(), avatarObserver:null, toastTimer:0, importBusy:false, editingCollectionId:null, artistNames:new Map(), refine:{tags:[],not:[]}, q:{words:[],nots:[],tags:[],notTags:[],artist:''}, density:'normal', shuffleSeed:String(Date.now()), sheetScope:'all', sheetDirty:false, homeArtistQuery:'', homeArtistSort:'name' };

  function openDB() {
    return new Promise((resolve,reject) => {
      const req = indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded = event => {
        const db=req.result;
        if(event.oldVersion<1){
          const media=db.createObjectStore('media',{keyPath:'id'});
          media.createIndex('relativePath','relativePath',{unique:true});
          db.createObjectStore('collections',{keyPath:'id'});
          db.createObjectStore('settings',{keyPath:'key'});
        }
        // v2: small preview images, kept apart from the originals so the
        // gallery never has to decode full-size files.
        if(event.oldVersion<2&&!db.objectStoreNames.contains('thumbs'))db.createObjectStore('thumbs',{keyPath:'id'});
      };
      req.onblocked=()=>showToast('Close other MediaLib tabs to finish updating the library.',6000);
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  function request(store,method,value) {
    return new Promise((resolve,reject)=>{
      const tx=state.db.transaction(store,method==='put'||method==='delete'?'readwrite':'readonly');
      const req=method==='getAll'?tx.objectStore(store).getAll():method==='get'?tx.objectStore(store).get(value):method==='put'?tx.objectStore(store).put(value):method==='delete'?tx.objectStore(store).delete(value):null;
      if(!req){reject(new Error('Unsupported local database request'));return;}
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  function writeMany(storeName,values) {
    return new Promise((resolve,reject)=>{
      const tx=state.db.transaction(storeName,'readwrite'); const store=tx.objectStore(storeName);
      values.forEach(v=>store.put(v)); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error||new Error('Local save was cancelled'));
    });
  }
  function prettyBytes(bytes) {
    if(!Number.isFinite(bytes)||bytes<=0)return '0 B';
    const units=['B','KB','MB','GB','TB']; const n=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),units.length-1);
    return `${(bytes/1024**n).toFixed(n?1:0)} ${units[n]}`;
  }
  function showToast(message,timeout=3300) {
    const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(state.toastTimer); state.toastTimer=setTimeout(()=>el.classList.remove('show'),timeout);
  }
  function safeText(value){return String(value??'');}
  function extOf(file){return (file.name.split('.').pop()||'').toLowerCase();}
  function mediaKind(file){const ext=extOf(file);if(IMAGE_EXT.has(ext)||file.type.startsWith('image/'))return'image';if(VIDEO_EXT.has(ext)||file.type.startsWith('video/'))return'video';if(AUDIO_EXT.has(ext)||file.type.startsWith('audio/'))return'audio';return'';}
  function normalizedPath(value){return String(value||'').replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'').toLocaleLowerCase();}
  function pathScore(a,b){
    const aa=normalizedPath(a).split('/').filter(Boolean),bb=normalizedPath(b).split('/').filter(Boolean);let n=0;
    for(let i=1;i<=Math.min(aa.length,bb.length);i++){if(aa.at(-i)!==bb.at(-i))break;n++;}return n;
  }
  function indexLegacy(){state.legacyByName=new Map();for(const entry of state.legacy){const key=String(entry.name||'').toLocaleLowerCase();if(!state.legacyByName.has(key))state.legacyByName.set(key,[]);state.legacyByName.get(key).push(entry);}}
  function legacyMatch(relativePath,name){
    const matches=state.legacyByName.get(String(name).toLocaleLowerCase())||[];
    if(!matches.length)return null;
    let best=null,score=0,tied=false;
    for(const candidate of matches){const s=pathScore(relativePath,candidate.path||candidate.relativePath||candidate.folder||'');if(s>score){best=candidate;score=s;tied=false}else if(s===score&&s>0)tied=true;}
    return score>0&&!tied?best:null;
  }
  function defaultCreator(relativePath){
    const parts=String(relativePath||'').split(/[\\/]/).filter(Boolean);
    // webkitRelativePath includes the chosen root directory as its first part.
    const underRoot=parts.slice(1);
    if(!underRoot.length)return'';
    let first=underRoot[0];
    if(['aryion','ary'].includes(first.toLocaleLowerCase()))first=underRoot[1]||'';
    else if(first.toLocaleLowerCase()==='.arygrabber-medialib-backup')first=underRoot[1]||'';
    return first;
  }
  function formatDate(value){return value?new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Date unknown';}
  function avatarKey(name){return String(name||'').trim().toLocaleLowerCase();}
  function avatarSource(name){const record=state.artistAvatars[avatarKey(name)];if(!record)return'';if(record.blob){const key=`avatar:${avatarKey(name)}`;if(!state.objectUrls.has(key))state.objectUrls.set(key,URL.createObjectURL(record.blob));return state.objectUrls.get(key);}return record.url||'';}
  function applyAvatarImage(image,name){const source=avatarSource(name),fallback=image.closest('.browse-folder-card')?.querySelector('[data-avatar-fallback]');if(!source){image.hidden=true;if(fallback)fallback.hidden=false;return;}image.onload=()=>{image.hidden=false;if(fallback)fallback.hidden=true;};image.onerror=()=>{image.hidden=true;if(fallback)fallback.hidden=false;};if(image.src!==source)image.src=source;}
  function updateAvatarImages(name){const key=avatarKey(name);for(const image of $$('[data-artist-avatar]'))if(image.dataset.artistAvatar===key)applyAvatarImage(image,name);for(const fallback of $$('[data-avatar-fallback]'))if(fallback.dataset.avatarFallback===key&&!avatarSource(name))fallback.hidden=false;updateHeading();}
  function updateHeading(){
    const filter=state.filter,artist=filter.type==='artist'||filter.type==='artist-folder'?artistDisplay(filter.artist)||'Unassigned':'';const image=$('#heading-artist-avatar');
    $('#crumb').textContent=artist?`YOUR LIBRARY: ${artist}`:'YOUR LIBRARY';
    if(artist){image.dataset.artistAvatar=avatarKey(artist);image.onerror=()=>{image.hidden=true;};applyAvatarImage(image,artist);if(!avatarSource(artist))ensureArtistAvatar(artist);}
    else{image.hidden=true;image.removeAttribute('src');delete image.dataset.artistAvatar;}
  }
  function ensureArtistAvatar(name){
    const key=avatarKey(name);if(!key||key==='unassigned'||state.artistAvatars[key]?.blob||state.artistAvatars[key]?.url||state.avatarLookups.has(key))return;
    state.avatarLookups.add(key);state.avatarQueue=state.avatarQueue.then(()=>new Promise(resolve=>setTimeout(resolve,500))).then(()=>lookupAryionAvatar(name)).catch(()=>{});
  }
  function observeArtistAvatar(card,name){if(avatarSource(name)||name==='Unassigned'){applyAvatarImage(card.querySelector('[data-artist-avatar]'),name);return;}if('IntersectionObserver'in window){if(!state.avatarObserver)state.avatarObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){state.avatarObserver.unobserve(entry.target);ensureArtistAvatar(entry.target.dataset.artistName);}}, {root:$('#gallery-wrap'),rootMargin:'120px'});card.dataset.artistName=name;state.avatarObserver.observe(card);}else ensureArtistAvatar(name);}
  async function lookupAryionAvatar(name){
    const key=avatarKey(name);if(state.artistAvatars[key]?.blob)return;const profileUrl=`https://aryion.com/g4/user/${encodeURIComponent(name)}`;
    try{
      const response=await fetch(profileUrl,{credentials:'omit'});if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const doc=new DOMParser().parseFromString(await response.text(),'text/html');if(state.artistAvatars[key]?.blob)return;let best=null,bestScore=0;
      for(const image of doc.images){const src=image.getAttribute('data-original')||image.getAttribute('data-src')||image.getAttribute('data-lazy-src')||image.getAttribute('src')||'';if(!src)continue;const marker=[image.alt,image.className,image.id,image.title,image.getAttribute('itemprop'),src].join(' ').toLocaleLowerCase();const score=marker.includes('avatar')&&marker.includes(key)?10:marker.includes('avatar')?8:marker.includes(key)&&/(profile|user|icon)/.test(marker)?6:/(avatar|profile-picture|profile_image|user-icon)/.test(marker)?5:0;if(score>bestScore){bestScore=score;best=src;}}
      if(!best){const og=doc.querySelector('meta[property="og:image"]')?.content||'';if(['avatar','profile','user',key].some(token=>token&&og.toLocaleLowerCase().includes(token)))best=og;}
      if(!best)return;const url=new URL(best,response.url||profileUrl);if(url.protocol!=='https:'||!(url.hostname==='aryion.com'||url.hostname.endsWith('.aryion.com')))return;
      state.artistAvatars[key]={name,url:url.href,source:'aryion'};await request('settings','put',{key:'artistAvatars',value:state.artistAvatars});updateAvatarImages(name);
    }catch(error){/* Aryion may disallow cross-origin profile reads; an imported AryGrabber avatar remains local-first. */}
  }
  function avatarBlob(file){if(file.size>5*1024*1024)return Promise.reject(new Error('Profile image is larger than 5 MB'));return file.slice(0,16).arrayBuffer().then(bytes=>{const b=new Uint8Array(bytes);let type='';if(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)type='image/jpeg';else if(b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47)type='image/png';else if(String.fromCharCode(...b.slice(0,4))==='GIF8')type='image/gif';else if(String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP')type='image/webp';else if(String.fromCharCode(...b.slice(4,12)).includes('ftypavif'))type='image/avif';if(!type)throw new Error('Not a supported image');return new Blob([file],{type});});}
  async function importArtistAvatars(records){
    let added=0;for(const {file,relative} of records){const parts=relative.split(/[\\/]/).filter(Boolean),artist=parts.at(-2)||'';if(!artist||['aryion','ary'].includes(artist.toLocaleLowerCase()))continue;try{const blob=await avatarBlob(file),key=avatarKey(artist),oldUrl=state.objectUrls.get(`avatar:${key}`);if(oldUrl)URL.revokeObjectURL(oldUrl);state.objectUrls.delete(`avatar:${key}`);state.artistAvatars[key]={name:artist,blob,relativePath:relative,source:'arygrabber'};added++;}catch{}}
    if(added){await request('settings','put',{key:'artistAvatars',value:state.artistAvatars});for(const record of records){const artist=record.relative.split(/[\\/]/).filter(Boolean).at(-2);if(artist)updateAvatarImages(artist);}}
    return added;
  }
  function artistSubfolder(item,artist){
    const folder=String(item.folder||'');if(!folder)return'';
    const target=String(artist||'').trim().toLocaleLowerCase();
    const parts=folder.split(/[\\/]/).filter(Boolean);const artistIndex=target?parts.findIndex(part=>part.toLocaleLowerCase()===target):-1;
    return artistIndex>=0?parts.slice(artistIndex+1).join('/'):folder;
  }

  async function refreshData(keepPosition=false){
    let localCollections;[state.local,localCollections]=await Promise.all([request('media','getAll'),request('collections','getAll')]);
    const pcFolders=pcCollections(),pcIds=new Set(pcFolders.map(c=>c.id));
    state.collections=[...localCollections.filter(c=>!pcIds.has(c.id)),...pcFolders].sort((a,b)=>a.name.localeCompare(b.name));
    state.all=[...state.local,...pcItems()];
    state.all.sort((a,b)=>(b.modified||0)-(a.modified||0)||a.name.localeCompare(b.name));
    buildArtistNames();
    state.byId=new Map(state.all.map(item=>[item.id,item]));
    renderSidebar(); updateHeading(); updateStorage(); applyFilter(keepPosition);
    backfillThumbs();
  }
  async function updateStorage(){
    if(!navigator.storage?.estimate){$('#storage-note').textContent='';return;}
    try{const {usage=0,quota=0}=await navigator.storage.estimate();$('#storage-note').textContent=`${prettyBytes(usage)} stored`+(quota?` · ${prettyBytes(quota)} available`:'');}catch{}
  }
  function setFilter(filter,title,opts={}){
    opts=opts&&typeof opts==='object'?opts:{};
    state.filter=filter;state.refine=opts.refine?{tags:[...(opts.refine.tags||[])],not:[...(opts.refine.not||[])]}:{tags:[],not:[]};
    if(opts.kind)state.kind=opts.kind;else if(filter.type==='home')state.kind='image';else if(filter.type!=='all')state.kind='all';
    $$('.filter-chip').forEach(button=>button.classList.toggle('active',button.dataset.kind===state.kind));
    if(title)$('#page-title').textContent=title;
    renderSidebar(); updateHeading(); applyFilter(); pushView();
    if(matchMedia('(max-width:560px)').matches){$('.sidebar').classList.remove('open');$('#mobile-nav-toggle').setAttribute('aria-expanded','false');}
  }
  function setKind(kind){state.kind=kind;$$('.filter-chip').forEach(b=>b.classList.toggle('active',b.dataset.kind===kind));applyFilter();replaceView();}
  function isInFilter(item){
    const f=state.filter;
    if(f.type==='home'&&!hasQuery())return false;
    if(f.type==='artist'&&ak(item.creator)!==ak(f.artist))return false;
    if(f.type==='artist-folder'&&(ak(item.creator)!==ak(f.artist)||artistSubfolder(item,f.artist)!==f.folder))return false;
    if(f.type==='tag'&&!hasTag(item,f.tag))return false;
    if(f.type==='collection'&&!(item.collectionIds||[]).includes(f.id))return false;
    if(state.kind!=='all'&&item.kind!==state.kind)return false;
    return matchesQuery(item);
  }
  function applyFilter(keepPosition=false){
    const wrap=$('#gallery-wrap'),previousPages=state.page,previousTop=wrap.scrollTop;
    state.q=parseQuery(state.query);state.visible=state.all.filter(isInFilter);sortVisible(state.visible);state.page=0;if(!keepPosition){state.selected.clear();$('#selection-bar').hidden=true;}
    if(state.filter.type==='home'&&!hasQuery()){const artistCount=new Set(state.all.map(x=>who(x)||'Unassigned')).size;const tagCount=new Set(state.all.flatMap(x=>x.tags||[])).size;$('#result-count').textContent=`${artistCount.toLocaleString()} ${artistCount===1?'artist':'artists'} · ${tagCount.toLocaleString()} tags`;}
    else $('#result-count').textContent=`${state.visible.length.toLocaleString()} ${state.visible.length===1?'item':'items'}`;
    renderPage(true);renderRefine();
    if(keepPosition){while(state.page<previousPages&&state.page*PAGE_SIZE<state.visible.length)renderPage(false);wrap.scrollTop=previousTop;updateSelection();}
    else wrap.scrollTop=0;
  }
  function navButton(text,icon,count,active,callback,extraClass=''){
    const b=document.createElement('button');b.className=`nav-row ${extraClass} ${active?'selected':''}`;b.type='button';
    const i=document.createElement('span');i.className='nav-icon';i.textContent=icon;b.append(i);
    const name=document.createElement('span');name.textContent=text;b.append(name);
    if(count!==undefined){const c=document.createElement('span');c.className='nav-count';c.textContent=count.toLocaleString();b.append(c);}
    b.addEventListener('click',callback);return b;
  }
  function renderSidebar(){
    const artistRoot=$('#artists'),tagRoot=$('#tags'),virtualRoot=$('#virtual-folders');artistRoot.replaceChildren();tagRoot.replaceChildren();virtualRoot.replaceChildren();
    const imageCount=state.all.filter(x=>x.kind==='image').length;
    $('#all-count').textContent=imageCount.toLocaleString();$('#media-count').textContent=state.all.length.toLocaleString();
    $$('[data-filter]').forEach(btn=>btn.classList.toggle('selected',btn.dataset.filter==='home'&&state.filter.type==='home'||state.filter.type==='all'&&(btn.dataset.filter==='all'&&state.kind==='image'||btn.dataset.filter==='all-media'&&state.kind==='all')));
    const artists=new Map();
    for(const item of state.all){const name=who(item)||'Unassigned';if(!artists.has(name))artists.set(name,[]);artists.get(name).push(item);}
    const sortedArtists=[...artists.entries()].sort((a,b)=>a[0]==='Unassigned'?1:b[0]==='Unassigned'?-1:a[0].localeCompare(b[0]));
    if(!sortedArtists.length){const e=document.createElement('div');e.className='artist-empty';e.textContent='Artists appear here when you add creator names to your media.';artistRoot.append(e);}
    const artistQuery=ak($('#artist-search')?.value);
    for(const [artist,items] of sortedArtists.filter(([name])=>!artistQuery||ak(name).includes(artistQuery))){
      const row=document.createElement('div');row.className='artist-group';
      const creatorKey=artist==='Unassigned'?'':artist;
      const isActive=state.filter.type==='artist'&&ak(state.filter.artist)===ak(creatorKey);
      const title=navButton(artist,'♙',items.length,isActive,()=>{state.expanded.add(artist);setFilter({type:'artist',artist:creatorKey},artist);});
      title.querySelector('.nav-row span:nth-child(2)')?.classList.add('artist-name');row.append(title);
      const toggle=document.createElement('button');toggle.type='button';toggle.className='artist-expand';toggle.textContent=state.expanded.has(artist)?'▾':'›';toggle.setAttribute('aria-label',`${state.expanded.has(artist)?'Collapse':'Expand'} ${artist} folders`);
      toggle.addEventListener('click',()=>{state.expanded.has(artist)?state.expanded.delete(artist):state.expanded.add(artist);renderSidebar();});row.append(toggle);artistRoot.append(row);
      if(state.expanded.has(artist)){
        const folderSet=new Set(items.map(x=>artistSubfolder(x,creatorKey)));const folderNames=[...folderSet].sort((a,b)=>a===''?-1:b===''?1:a.localeCompare(b));
        const sub=document.createElement('div');sub.className='artist-folders';
        for(const folder of folderNames){const label=folder||'Unorganized files';const active=state.filter.type==='artist-folder'&&ak(state.filter.artist)===ak(creatorKey)&&state.filter.folder===folder;sub.append(navButton(label,'↳',items.filter(x=>artistSubfolder(x,creatorKey)===folder).length,active,()=>setFilter({type:'artist-folder',artist:creatorKey,folder},label,'folder-row')));}
        artistRoot.append(sub);
      }
    }
    const counts=new Map();for(const item of state.all)for(const tag of item.tags||[])counts.set(tag,(counts.get(tag)||0)+1);
    $('#browse-count').textContent=(sortedArtists.length+counts.size).toLocaleString();
    const tagQuery=$('#tag-search').value.trim().toLocaleLowerCase();const sortedTags=[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const filtered=sortedTags.filter(([tag])=>tag.toLocaleLowerCase().includes(tagQuery));const show=tagQuery||state.showAllTags?filtered:filtered.slice(0,14);
    for(const [tag,count] of show)tagRoot.append(navButton(tag,'#',count,state.filter.type==='tag'&&state.filter.tag===tag,()=>setFilter({type:'tag',tag},tag),'tag-row'));
    $('#more-tags').hidden=!!tagQuery||filtered.length<=14;$('#more-tags').textContent=state.showAllTags?'Show fewer tags':'Show all tags';
    for(const folder of state.collections){
      const row=document.createElement('div');row.className='artist-group';const count=state.all.filter(x=>(x.collectionIds||[]).includes(folder.id)).length;
      row.append(navButton(folder.name,'▱',count,state.filter.type==='collection'&&state.filter.id===folder.id,()=>setFilter({type:'collection',id:folder.id},folder.name)));
      const rename=document.createElement('button');rename.className='virtual-delete';rename.type='button';rename.textContent='✎';rename.title='Rename virtual folder';rename.setAttribute('aria-label',`Rename virtual folder ${folder.name}`);rename.addEventListener('click',()=>openFolderDialog(folder));row.append(rename);
      const del=document.createElement('button');del.className='virtual-delete';del.type='button';del.textContent='×';del.setAttribute('aria-label',`Delete virtual folder ${folder.name}`);del.addEventListener('click',e=>{e.stopPropagation();deleteCollection(folder);});row.append(del);virtualRoot.append(row);
    }
    $('#empty-folders').hidden=state.collections.length>0;
    const select=$('#collection-select');const old=select.value;select.replaceChildren(new Option('Choose virtual folder…',''));for(const c of state.collections)select.add(new Option(c.name,c.id));if(state.collections.some(c=>c.id===old))select.value=old;
  }
  function revokeUrls(includeAvatars=false){for(const [key,url] of state.objectUrls){if(includeAvatars||!key.startsWith('avatar:')){URL.revokeObjectURL(url);state.objectUrls.delete(key);}}}
  function mediaURL(item){if(!state.objectUrls.has(item.id))state.objectUrls.set(item.id,URL.createObjectURL(item.blob));return state.objectUrls.get(item.id);}
  // ---- Thumbnails ---------------------------------------------------------
  // Tiles show a ≤480px JPEG made once per file and stored in IndexedDB, so
  // scrolling never decodes multi-megabyte originals (the main cause of
  // slowness and crashes on phones).
  function thumbFresh(item){const t=state.thumbs.get(item.id);return !!t&&t.size===item.size&&t.modified===item.modified;}
  function thumbURL(item){if(!thumbFresh(item))return'';let url=state.thumbUrls.get(item.id);if(!url){url=URL.createObjectURL(state.thumbs.get(item.id).blob);state.thumbUrls.set(item.id,url);}return url;}
  function dropThumbUrl(id){const url=state.thumbUrls.get(id);if(url){URL.revokeObjectURL(url);state.thumbUrls.delete(id);}}
  function canvasFor(w,h){if(typeof OffscreenCanvas!=='undefined')return new OffscreenCanvas(w,h);const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
  function encodeCanvas(canvas){return canvas.convertToBlob?canvas.convertToBlob({type:'image/jpeg',quality:.8}):new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('encode failed')),'image/jpeg',.8));}
  function drawThumb(source,width,height){
    const scale=Math.min(1,THUMB_MAX/Math.max(width,height)),w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
    const canvas=canvasFor(w,h),ctx=canvas.getContext('2d');ctx.fillStyle='#1b1e20';ctx.fillRect(0,0,w,h);ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,w,h);return encodeCanvas(canvas);
  }
  function withTimeout(promise,ms){return Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),ms))]);}
  async function imageThumb(blob){
    if('createImageBitmap'in window){try{const bitmap=await createImageBitmap(blob);try{return await drawThumb(bitmap,bitmap.width,bitmap.height);}finally{bitmap.close?.();}}catch{}}
    const url=URL.createObjectURL(blob);try{const img=new Image();img.decoding='async';img.src=url;await withTimeout(img.decode(),20000);return await drawThumb(img,img.naturalWidth,img.naturalHeight);}finally{URL.revokeObjectURL(url);}
  }
  async function videoThumb(blob){
    const url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';video.src=url;
    try{
      await withTimeout(new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('video'));}),15000);
      const target=Math.min(1,(video.duration||0)/3);if(target>0){video.currentTime=target;await withTimeout(new Promise(resolve=>{video.onseeked=resolve;}),8000).catch(()=>{});}
      return await drawThumb(video,video.videoWidth,video.videoHeight);
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  }
  function queueThumb(item,urgent=false){
    if(!item||item.kind==='audio'||thumbFresh(item)||state.thumbFailed.has(item.id))return;
    if(item.remote&&state.pc.status!=='ok')return;
    if(state.thumbQueued.has(item.id)){if(urgent){const i=state.thumbQueue.indexOf(item.id);if(i>0){state.thumbQueue.splice(i,1);state.thumbQueue.unshift(item.id);}}return;}
    state.thumbQueued.add(item.id);urgent?state.thumbQueue.unshift(item.id):state.thumbQueue.push(item.id);pumpThumbs();
  }
  function pumpThumbs(){
    const limit=navigator.hardwareConcurrency>4?3:2;
    while(state.thumbWorkers<limit&&state.thumbQueue.length){state.thumbWorkers++;thumbWorker().finally(()=>{state.thumbWorkers--;pumpThumbs();});}
  }
  async function thumbWorker(){
    while(state.thumbQueue.length){
      const id=state.thumbQueue.shift(),item=state.byId.get(id);state.thumbQueued.delete(id);
      if(!item||thumbFresh(item))continue;
      try{
        const blob=item.remote?await pcThumb(item):item.kind==='video'?await videoThumb(item.blob):await imageThumb(item.blob);
        const record={id,blob,size:item.size,modified:item.modified};await request('thumbs','put',record);
        dropThumbUrl(id);state.thumbs.set(id,record);
        const url=thumbURL(item);for(const img of $$(`img[data-thumb-for="${CSS.escape(id)}"]`)){img.src=url;img.closest('.media-preview')?.classList.remove('pending');}
      }catch{state.thumbFailed.add(id);for(const holder of $$(`.media-preview[data-preview-for="${CSS.escape(id)}"]`))useOriginalPreview(holder,item);}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  function useOriginalPreview(holder,item){
    holder.classList.remove('pending');holder.replaceChildren();
    if(item.remote){const icon=document.createElement('span');icon.className='media-placeholder';icon.textContent=item.kind==='video'?'▶':'▧';icon.title='Preview needs your PC';holder.append(icon);return;}
    if(item.kind==='image'){const img=document.createElement('img');img.src=mediaURL(item);img.alt=item.name;img.loading='lazy';img.decoding='async';holder.append(img);}
    else if(item.kind==='video'){const video=document.createElement('video');video.src=mediaURL(item);video.preload='metadata';video.muted=true;video.playsInline=true;holder.append(video);}
    else{const icon=document.createElement('span');icon.className='media-placeholder';icon.textContent='♫';holder.append(icon);}
  }
  function observeThumb(holder,item){
    if(!('IntersectionObserver'in window)){queueThumb(item,true);return;}
    if(!state.thumbObserver)state.thumbObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){state.thumbObserver.unobserve(entry.target);queueThumb(state.byId.get(entry.target.dataset.previewFor),true);}},{root:$('#gallery-wrap'),rootMargin:'400px'});
    state.thumbObserver.observe(holder);
  }
  function backfillThumbs(){
    // Quietly make previews for everything else, newest first, so later
    // browsing is instant. Visible tiles always jump the queue.
    const run=()=>{for(const item of state.all)if(!item.remote&&item.kind!=='audio'&&!thumbFresh(item))queueThumb(item);};
    'requestIdleCallback'in window?requestIdleCallback(run,{timeout:4000}):setTimeout(run,1500);
  }
  function createPreview(item,detail=false){
    if(!detail){
      const holder=document.createElement('div');holder.className='media-preview';holder.dataset.previewFor=item.id;
      if(item.kind==='audio'){const icon=document.createElement('span');icon.className='media-placeholder';icon.textContent='♫';holder.append(icon);return holder;}
      if(state.thumbFailed.has(item.id)){useOriginalPreview(holder,item);return holder;}
      const img=document.createElement('img');img.alt=item.name;img.decoding='async';img.dataset.thumbFor=item.id;
      const url=thumbURL(item);if(url){img.src=url;}else if(item.remote&&state.pc.status!=='ok'){useOriginalPreview(holder,item);return holder;}else{holder.classList.add('pending');observeThumb(holder,item);}
      holder.append(img);if(item.kind==='video'){const badge=document.createElement('span');badge.className='media-badge';badge.textContent='▶';holder.append(badge);}
      return holder;
    }
    const holder=document.createElement('div');holder.className=detail?'detail-preview':'media-preview';
    if(item.remote)return remoteDetailPreview(holder,item);
    if(item.kind==='image'){
      const img=document.createElement('img');img.src=mediaURL(item);img.alt=item.name;img.loading=detail?'eager':'lazy';holder.append(img);
    }else if(item.kind==='video'){
      const video=document.createElement('video');video.src=mediaURL(item);video.preload=detail?'metadata':'none';video.muted=true;video.playsInline=true;if(detail){video.controls=true;}else{video.setAttribute('aria-label',item.name);}holder.append(video);
    }else{const icon=document.createElement('span');icon.className=detail?'detail-audio':'media-placeholder';icon.textContent='♫';holder.append(icon);}
    return holder;
  }
  function stopDetailVideos(){for(const video of $$('#detail-content video')){try{video.pause();video.removeAttribute('src');video.load();}catch{}}}
  function remoteDetailPreview(holder,item){
    // Images come as a screen-sized copy and videos stream (seekable), so
    // nothing big has to arrive before you see it. "Full size" fetches the original.
    const thumb=thumbURL(item);if(thumb&&item.kind!=='audio'){const img=document.createElement('img');img.src=thumb;img.alt=item.name;img.className='remote-placeholder';holder.append(img);}
    const note=document.createElement('span');note.className='detail-loading remote-placeholder';note.textContent='Loading from your PC…';holder.append(note);
    const fail=()=>{if(state.detailItemId!==item.id)return;note.textContent='Couldn’t load this from your PC. It may be asleep, or Tailscale is off on this phone.';note.classList.add('error');if(!note.isConnected)holder.append(note);};
    const endpoint=item.kind==='image'?'view':'file';
    pcLinkURL(endpoint,item).then(url=>{
      if(state.detailItemId!==item.id)return;let media;
      if(item.kind==='video'){media=document.createElement('video');media.controls=true;media.playsInline=true;media.preload='metadata';if(thumb)media.poster=thumb;holder.prepend(media);$$('.remote-placeholder',holder).forEach(x=>x.remove());}
      else if(item.kind==='audio'){media=document.createElement('audio');media.controls=true;holder.prepend(media);$$('.remote-placeholder',holder).forEach(x=>x.remove());}
      else{media=document.createElement('img');media.alt=item.name;media.decoding='async';media.className='remote-full';media.onload=()=>{if(!media.isConnected){$$('.remote-placeholder',holder).forEach(x=>x.remove());holder.prepend(media);}};}
      media.onerror=fail;media.src=url;
    }).catch(fail);
    return holder;
  }
  // ---- Your PC (AryGrabber phone access over Tailscale) --------------------
  // Items listed by the PC are never copied into this browser. The list is
  // cached so the library can be browsed offline; previews of what you've
  // scrolled past are kept in the thumbs store. Virtual folders and edits on
  // PC items are saved ON THE PC (<AryGrabber folder>/.medialib-library.json),
  // so every connected device and AryGrabber share them; changes made while the
  // PC is asleep wait here and are sent when it answers again.
  function pcAllowedUrl(value){
    try{const url=new URL(String(value||'').trim());if(url.protocol==='https:'&&!url.username&&!url.password)return url.origin;if(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))return url.origin;}catch{}
    return'';
  }
  async function pcFetch(path,timeout=10000,options={}){
    const link=state.pc.link;if(!link)throw new Error('Not connected to your PC');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetch(link.url+path,{...options,headers:{Authorization:`Bearer ${link.key}`,...(options.headers||{})},credentials:'omit',cache:'no-store',signal:controller.signal});
      if(response.status===401)throw Object.assign(new Error('Your PC rejected the access key. Pair again from AryGrabber → Phone access.'),{auth:true});
      if(!response.ok&&response.status!==304)throw new Error(`Your PC answered HTTP ${response.status}`);
      return response;
    }catch(error){if(error.name==='AbortError')throw new Error('Your PC did not answer (it may be asleep, off, or Tailscale is disconnected).');if(error instanceof TypeError)throw new Error('Can’t reach your PC. Check that it’s awake, AryGrabber is sharing, and Tailscale is on here.');throw error;}
    finally{clearTimeout(timer);}
  }
  // <img>/<video> can't send the key header, so each file link is signed
  // with it instead (the server checks the same HMAC). A link opens only that
  // one file and expires within two days; the key itself never goes in a URL.
  async function pcSign(endpoint,id,expires){
    const key=state.pc.link.key;
    if(state.pc.signingFor!==key){state.pc.signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);state.pc.signingFor=key;}
    const mac=new Uint8Array(await crypto.subtle.sign('HMAC',state.pc.signingKey,new TextEncoder().encode(`${endpoint}/${id}/${expires}`)));
    let text='';for(const b of mac)text+=String.fromCharCode(b);return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  }
  async function pcLinkURL(endpoint,item,extra=''){
    if(!state.pc.link)throw new Error('Not connected to your PC');
    const expires=(Math.floor(Date.now()/86400000)+2)*86400; // same link all day, so the browser can cache it
    return `${state.pc.link.url}/api/${endpoint}/${encodeURIComponent(item.id)}?exp=${expires}&sig=${await pcSign(endpoint,item.id,expires)}${extra}`;
  }
  function pcItems(){
    const local=new Set(state.local.map(x=>normalizedPath(x.relativePath)));const out=[];
    for(const entry of state.pc.catalog?.items||[]){
      if(!entry?.id||local.has(normalizedPath(entry.relativePath)))continue;
      out.push({id:entry.id,title:entry.title||'',relativePath:entry.relativePath,name:entry.name||String(entry.relativePath||'').split('/').pop(),folder:entry.folder||'',kind:entry.kind||'image',size:entry.size||0,modified:entry.modified||0,creator:entry.creator||'',tags:Array.isArray(entry.tags)?entry.tags:[],notes:entry.notes||'',collectionIds:Array.isArray(entry.collectionIds)?entry.collectionIds:[],remote:true,blob:null});
    }
    return out;
  }
  function pcCollections(){return (state.pc.link&&state.pc.catalog?.collections||[]).filter(c=>c?.id&&c.name).map(c=>({id:c.id,name:c.name,created:c.created||0,remote:true}));}
  // Mirrors apply_ops() in medialib_server.py so the screen updates at once.
  function pcApply(op){
    const catalog=state.pc.catalog||(state.pc.catalog={items:[],collections:[],avatars:[],fetchedAt:0});catalog.collections=catalog.collections||[];
    const byPath=()=>new Map(catalog.items.map(x=>[normalizedPath(x.relativePath),x]));
    if(op.op==='collection'){const found=catalog.collections.find(c=>c.id===op.id);if(found)found.name=op.name;else catalog.collections.push({id:op.id,name:op.name,created:op.created||Date.now()});}
    else if(op.op==='delete-collection'){catalog.collections=catalog.collections.filter(c=>c.id!==op.id);for(const x of catalog.items)if((x.collectionIds||[]).includes(op.id))x.collectionIds=x.collectionIds.filter(id=>id!==op.id);}
    else if(op.op==='item'){const x=byPath().get(normalizedPath(op.path));if(x)for(const field of ['creator','tags','notes','collectionIds'])if(field in op)x[field]=op[field];}
    else if(op.op==='add-to-collection'){const map=byPath();for(const path of op.paths||[]){const x=map.get(normalizedPath(path));if(x&&!(x.collectionIds||[]).includes(op.id))x.collectionIds=[...(x.collectionIds||[]),op.id];}}
  }
  async function pcQueue(ops){
    for(const op of ops)pcApply(op);state.pc.pending.push(...ops);
    await Promise.all([request('settings','put',{key:'pcCatalog',value:state.pc.catalog}),request('settings','put',{key:'pcPending',value:state.pc.pending})]);
    return pcFlush();
  }
  async function pcFlush(){
    if(!state.pc.link||!state.pc.pending.length)return true;if(state.pc.flushing)return state.pc.flushing;
    const ops=state.pc.pending.slice();
    state.pc.flushing=(async()=>{
      try{
        const reply=await (await pcFetch('/api/state',20000,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ops})})).json();
        state.pc.pending=state.pc.pending.slice(ops.length);if(state.pc.catalog&&Array.isArray(reply.collections))state.pc.catalog.collections=reply.collections;
        await Promise.all([request('settings','put',{key:'pcPending',value:state.pc.pending}),request('settings','put',{key:'pcCatalog',value:state.pc.catalog})]);
        if(state.pc.status!=='ok')pcSetStatus('ok');else renderPcStatus();return true;
      }catch(error){if(state.pc.status==='ok')pcSetStatus(error.auth?'auth':'offline',error.message);else renderPcStatus();return false;}
      finally{state.pc.flushing=null;}
    })();
    return state.pc.flushing;
  }
  // A local-only virtual folder that gains PC items moves to the PC (same id),
  // so other devices see it too.
  async function pcPromoteCollections(ids){
    const local=state.collections.filter(c=>!c.remote&&ids.includes(c.id));if(!local.length)return[];
    for(const c of local)await request('collections','delete',c.id);
    return local.map(c=>({op:'collection',id:c.id,name:c.name,created:c.created||Date.now()}));
  }
  async function pcSaveEdit(item){
    const ops=[...await pcPromoteCollections(item.collectionIds||[]),{op:'item',path:item.relativePath,creator:item.creator,tags:item.tags,notes:item.notes,collectionIds:item.collectionIds||[]}];
    return pcQueue(ops);
  }
  function pcSavedMessage(sent){return sent?'Saved to your PC.':'Saved here; it will reach your PC when the PC is awake.';}
  function pcSetStatus(status,message=''){state.pc.status=status;state.pc.message=message;renderPcStatus();}
  function renderPcStatus(){
    const pc=state.pc,el=$('#pc-status');if(!el)return;const count=(pc.catalog?.items||[]).length;
    const when=pc.catalog?.fetchedAt?new Date(pc.catalog.fetchedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
    const waiting=pc.pending.length?` ${pc.pending.length} ${pc.pending.length===1?'change is':'changes are'} waiting to be sent to the PC.`:'';
    el.textContent=(!pc.link?'Not connected. In AryGrabber, open Phone access and scan the pairing code, or enter the address and key here.':pc.status==='ok'?`Connected to ${pc.name||'your PC'} · ${count.toLocaleString()} items. Virtual folders and edits on PC items are saved on the PC.`:pc.status==='checking'?'Checking your PC…':`${pc.message||'Your PC is offline.'}${count?` Showing the list saved ${when}; previews you’ve seen still work, but opening files needs the PC.`:''}`)+(pc.link?waiting:'');
    el.dataset.state=pc.link?pc.status:'off';
    $('#pc-connect').textContent=pc.link?'Change PC address or key':'Connect to my PC';$('#pc-refresh').hidden=!pc.link;$('#pc-disconnect').hidden=!pc.link;
    const foot=$('#privacy-label');if(foot)foot.textContent=pc.link?(pc.status==='ok'?'Private · linked to your PC':'Private · PC offline'):'Private on this device';
  }
  async function pcRefresh(quiet=false){
    if(!state.pc.link||state.pc.refreshing)return;state.pc.refreshing=true;pcSetStatus('checking');
    try{
      await pcFlush();
      const previous=state.pc.catalog,response=await pcFetch('/api/catalog',30000,{headers:previous?.etag&&!state.pc.pending.length?{'If-None-Match':previous.etag}:{}});
      const unchanged=response.status===304&&!!previous;let catalog;
      if(unchanged)catalog=previous;else{catalog=await response.json();if(!Array.isArray(catalog.items))throw new Error('Your PC sent an unexpected reply.');catalog.etag=response.headers.get('ETag')||'';}
      state.pc.catalog={items:catalog.items,collections:Array.isArray(catalog.collections)?catalog.collections:[],avatars:catalog.avatars||[],etag:catalog.etag||'',fetchedAt:Date.now()};
      for(const op of state.pc.pending)pcApply(op); // anything still unsent stays visible
      state.pc.name=catalog.name||'';state.pc.checked=Date.now();for(const entry of catalog.items)state.thumbFailed.delete(entry.id);
      await request('settings','put',{key:'pcCatalog',value:state.pc.catalog});pcSetStatus('ok');if(!unchanged||!state.all.some(x=>x.remote))await refreshData(true);pcLoadAvatars();
      if(!quiet)showToast(`Your PC is connected · ${catalog.items.length.toLocaleString()} items.`);
    }catch(error){state.pc.checked=Date.now();pcSetStatus(error.auth?'auth':'offline',error.message);if(!quiet||error.auth)showToast(error.message,6000);}
    finally{state.pc.refreshing=false;}
  }
  async function pcLoadAvatars(){
    let changed=false;
    for(const name of state.pc.catalog?.avatars||[]){
      const key=avatarKey(name);if(state.artistAvatars[key]?.blob)continue;
      try{const blob=await avatarBlob(await (await pcFetch(`/api/avatar/${encodeURIComponent(name)}`)).blob());state.artistAvatars[key]={name,blob,source:'pc'};changed=true;updateAvatarImages(name);}catch{}
    }
    if(changed)await request('settings','put',{key:'artistAvatars',value:state.artistAvatars});
  }
  async function pcThumb(item){return (await pcFetch(`/api/thumb/${encodeURIComponent(item.id)}`,30000)).blob();}
  async function pcSaveLink(url,key,{silent=false}={}){
    const origin=pcAllowedUrl(url);key=String(key||'').trim();
    if(!origin){showToast('Use the https:// address shown in AryGrabber (it ends in .ts.net).',6000);return false;}
    if(key.length<16){showToast('That access key looks too short. Copy it from AryGrabber → Phone access.',6000);return false;}
    const changed=state.pc.link?.url!==origin;state.pc.link={url:origin,key};
    if(changed){state.pc.catalog=null;state.pc.pending=[];await request('settings','put',{key:'pcCatalog',value:null});await request('settings','put',{key:'pcPending',value:[]});}
    await request('settings','put',{key:'pcLink',value:state.pc.link});renderPcStatus();await pcRefresh(silent);return true;
  }
  function pcReset(){state.pc={link:null,catalog:null,pending:[],status:'off',message:'',name:''};}
  async function pcDisconnect(){
    const waiting=state.pc.pending.length?` ${state.pc.pending.length} unsent ${state.pc.pending.length===1?'change':'changes'} to PC items will be lost.`:'';
    if(!confirm(`Disconnect from your PC? Its items and saved previews will be removed from this browser.${waiting} Nothing on your PC changes.`))return;
    const ids=new Set((state.pc.catalog?.items||[]).map(x=>x.id));
    pcReset();
    for(const key of ['pcLink','pcCatalog','pcPending','pcEdits'])await request('settings','delete',key);
    for(const id of ids){dropThumbUrl(id);state.thumbs.delete(id);state.thumbFailed.delete(id);try{await request('thumbs','delete',id);}catch{}}
    for(const [key,record] of Object.entries(state.artistAvatars))if(record.source==='pc')delete state.artistAvatars[key];
    await request('settings','put',{key:'artistAvatars',value:state.artistAvatars});renderPcStatus();await refreshData();showToast('Disconnected from your PC.');
  }
  function pcReadPairing(){
    // AryGrabber's QR code opens  …/#pair=<base64url JSON {url,key}>.
    const match=/^#pair=([A-Za-z0-9_-]+)$/.exec(location.hash);if(!match)return null;
    history.replaceState(null,'',location.pathname+location.search);
    try{const json=JSON.parse(atob(match[1].replaceAll('-','+').replaceAll('_','/')));return json&&typeof json==='object'?json:null;}catch{return null;}
  }
  function openPcDialog(){
    $('#pc-url').value=state.pc.link?.url||'';$('#pc-key').value='';$('#pc-key').placeholder=state.pc.link?'Leave empty to keep the current key':'Paste the access key';
    $('#manage-dialog').close();$('#pc-dialog').showModal();
  }
  async function pcLoadSaved(){
    // Before the first render, so the saved PC list shows even when the PC is asleep.
    const [link,catalog,pending,oldEdits]=await Promise.all(['pcLink','pcCatalog','pcPending','pcEdits'].map(key=>request('settings','get',key)));
    state.pc.link=link?.value||null;state.pc.catalog=catalog?.value||null;state.pc.pending=Array.isArray(pending?.value)?pending.value:[];
    if(oldEdits?.value&&state.pc.catalog){
      // Edits saved by the previous version only lived in this browser; send them to the PC.
      const byId=new Map(state.pc.catalog.items.map(x=>[x.id,x]));
      for(const [id,edit] of Object.entries(oldEdits.value)){const x=byId.get(id);if(x)state.pc.pending.push({op:'item',path:x.relativePath,...edit});}
      for(const op of state.pc.pending)pcApply(op);
      await request('settings','put',{key:'pcPending',value:state.pc.pending});await request('settings','delete','pcEdits');
    }
    if(state.pc.link)state.pc.status='checking';
  }
  async function pcInit(){
    const pairing=pcReadPairing();
    if(pairing){
      const origin=pcAllowedUrl(pairing.url);
      if(origin&&pairing.key&&confirm(`Connect MediaLib to your PC at ${origin}? Only use a code from your own AryGrabber.`))await pcSaveLink(origin,pairing.key);
      else if(!origin)showToast('That pairing link isn’t valid.',5000);
    }else if(state.pc.link)pcRefresh(true);
    renderPcStatus();
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state.pc.link&&Date.now()-(state.pc.checked||0)>60000)pcRefresh(true);});
    window.addEventListener('online',()=>{if(state.pc.link)pcRefresh(true);});
  }
  // ---- AryGrabber sidecars picked up automatically on Import folder ---------
  // Choosing the AryGrabber folder brings in .medialib-catalog.json (artists,
  // tags) and .medialib-library.json (virtual folders, edits) with the media,
  // so there's no separate "Import catalog" step.
  async function readSidecars(records){
    let catalogEntries=[],shared=null;
    for(const {file} of records){
      try{const json=JSON.parse(await file.text());if(/^\.medialib-library\.json$/i.test(file.name)){if(json&&typeof json.items==='object')shared=json;}else if(Array.isArray(json?.items))catalogEntries.push(...json.items);}catch{}
    }
    if(!catalogEntries.length&&!shared)return 0;
    const byPath=new Map();for(const entry of [...state.legacy,...catalogEntries]){const key=normalizedPath(entry.path||entry.relativePath||'');if(key)byPath.set(key,{...entry});}
    if(shared){
      for(const [path,edit] of Object.entries(shared.items||{})){const key=normalizedPath(path);const entry=byPath.get(key)||{path,name:path.split('/').pop()};for(const field of ['creator','tags','notes','collectionIds'])if(field in edit)entry[field]=edit[field];byPath.set(key,entry);}
      const known=new Set(state.collections.map(c=>c.id));
      for(const c of shared.collections||[])if(c?.id&&c.name&&!known.has(c.id))await request('collections','put',{id:c.id,name:c.name,created:c.created||Date.now()});
    }
    state.legacy=[...byPath.values()];indexLegacy();await request('settings','put',{key:'legacyCatalog',value:state.legacy});
    return catalogEntries.length+Object.keys(shared?.items||{}).length;
  }

  function renderBrowseHome(){
    const gallery=$('#gallery');gallery.replaceChildren();revokeUrls();$('#load-more').hidden=true;
    $('#empty-state').hidden=state.all.length>0;
    if(!state.all.length){$('#empty-title').textContent='Your library starts here.';$('#empty-text').textContent='Import a folder or choose individual photos and files, or connect to your PC in Library tools.';return;}
    const home=document.createElement('div');home.className='browse-home';
    const section=(title,extra)=>{const block=document.createElement('section');block.className='browse-home-section';const head=document.createElement('div');head.className='home-head';const h=document.createElement('h2');h.textContent=title;head.append(h);if(extra)head.append(...extra);block.append(head);home.append(block);return block;};
    // Newest
    const newest=state.all.filter(x=>x.kind!=='audio').slice(0,18);
    if(newest.length){
      const block=section('Newest',[chip('See all ›','text-button',()=>{state.sort='newest';$('#sort-select').value='newest';setFilter({type:'all'},'All media',{kind:'all'});})]);
      const strip=document.createElement('div');strip.className='recent-strip';
      for(const item of newest){const tile=document.createElement('button');tile.type='button';tile.className='recent-tile';tile.title=item.title||item.name;tile.append(createPreview(item));tile.addEventListener('click',()=>{state.sort='newest';$('#sort-select').value='newest';setFilter({type:'all'},'All media',{kind:'all'});openDetail(item,state.visible.indexOf(item));});strip.append(tile);}
      block.append(strip);
    }
    // Virtual folders
    if(state.collections.length){
      const block=section('Virtual folders');const row=document.createElement('div');row.className='home-chips';
      for(const folder of [...state.collections].sort((a,b)=>(b.name.toLocaleLowerCase()==='favorites')-(a.name.toLocaleLowerCase()==='favorites')||a.name.localeCompare(b.name))){const count=state.all.filter(x=>(x.collectionIds||[]).includes(folder.id)).length;row.append(chip(`${folder.name.toLocaleLowerCase()==='favorites'?'♥':'▱'} ${folder.name} · ${count}`,'home-chip',()=>setFilter({type:'collection',id:folder.id},folder.name)));}
      block.append(row);
    }
    // Artists
    const search=document.createElement('input');search.type='search';search.className='home-search';search.placeholder='Find an artist…';search.value=state.homeArtistQuery;search.setAttribute('aria-label','Find an artist');
    const sort=document.createElement('select');sort.className='home-sort';sort.setAttribute('aria-label','Sort artists');for(const [v,l] of [['name','A–Z'],['count','Most items'],['newest','Newest']])sort.add(new Option(l,v));sort.value=state.homeArtistSort;
    const artistBlock=section(`Artists · ${new Set(state.all.map(x=>who(x)||'Unassigned')).size.toLocaleString()}`,[search,sort]);
    const grid=document.createElement('div');grid.className='browse-folder-grid';artistBlock.append(grid);renderArtistCards(grid);
    let t=0;search.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(()=>{state.homeArtistQuery=search.value;renderArtistCards(grid);},120);});
    sort.addEventListener('change',()=>{state.homeArtistSort=sort.value;renderArtistCards(grid);});
    // Tags
    const tags=new Map();for(const item of state.all)for(const tag of item.tags||[])tags.set(tag,(tags.get(tag)||0)+1);
    if(tags.size){
      const block=section(`Popular tags · ${tags.size.toLocaleString()}`,[chip('All tags…','text-button',()=>openTagSheet('all'))]);const row=document.createElement('div');row.className='home-chips';
      for(const [tag,count] of [...tags].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,36))row.append(chip(`#${tag} · ${count}`,'home-chip tag',()=>setFilter({type:'tag',tag},tag)));
      block.append(row);
    }
    gallery.append(home);
  }
  function renderPage(reset=false){
    if(reset){revokeUrls();$('#gallery').replaceChildren();}
    if(state.filter.type==='home'&&!hasQuery()){renderBrowseHome();return;}
    $('#empty-state').hidden=state.visible.length!==0;
    if(!state.visible.length){$('#load-more').hidden=true;$('#empty-title').textContent=state.all.length?'No matches in this view.':'Your library starts here.';$('#empty-text').textContent=state.all.length?'Try another tag, artist, or search.':'Choose a folder on your computer or photos and files on your phone. Originals stay where they are; MediaLib keeps a private copy on this device.';return;}
    const start=state.page*PAGE_SIZE,end=Math.min(start+PAGE_SIZE,state.visible.length);const frag=document.createDocumentFragment();
    for(let i=start;i<end;i++){
      const item=state.visible[i],card=document.createElement('article');card.className='media-card';card.dataset.id=item.id;card.addEventListener('click',()=>openDetail(item,i));
      const check=document.createElement('input');check.type='checkbox';check.className='media-check';check.checked=state.selected.has(item.id);check.setAttribute('aria-label',`Select ${item.name}`);check.addEventListener('click',e=>e.stopPropagation());check.addEventListener('change',()=>{check.checked?state.selected.add(item.id):state.selected.delete(item.id);updateSelection();});card.append(check);
      card.append(createPreview(item));
      const title=document.createElement('div');title.className='media-title';title.textContent=item.name;title.title=item.name;card.append(title);
      const tags=document.createElement('div');tags.className='media-tags';for(const value of item.tags||[]){const tagChip=document.createElement('span');tagChip.className='media-tag';tagChip.textContent=value;tagChip.addEventListener('click',e=>{e.stopPropagation();addRefine(value);});tags.append(tagChip);}card.append(tags);
      const creator=document.createElement('div');creator.className='media-creator';creator.textContent=who(item);card.append(creator);
      frag.append(card);
    }
    $('#gallery').append(frag);state.page=Math.ceil(end/PAGE_SIZE);$('#load-more').hidden=end>=state.visible.length;
  }
  function updateSelection(){
    $('#selection-count').textContent=`${state.selected.size} selected`;$('#selection-bar').hidden=state.selected.size===0;
    $$('.media-card').forEach(card=>{const cb=$('.media-check',card);if(cb)cb.checked=state.selected.has(card.dataset.id);});
  }
  function releaseDetailMedia(){const id=state.detailItemId;if(id&&state.objectUrls.has(id)&&!state.thumbFailed.has(id)){URL.revokeObjectURL(state.objectUrls.get(id));state.objectUrls.delete(id);}state.detailItemId=null;}
  function stepDetail(direction){
    if(state.detailIndex<0||!$('#detail-dialog').open)return;const next=state.detailIndex+direction;if(next<0||next>=state.visible.length)return;
    if(next>=state.page*PAGE_SIZE)renderPage(false);openDetail(state.visible[next],next);
  }
  async function openDetail(item,index=state.visible.indexOf(item)){
    const dialog=$('#detail-dialog'),root=$('#detail-content');stopDetailVideos();root.replaceChildren();releaseDetailMedia();state.detailIndex=index;state.detailItemId=item.id;const inner=document.createElement('div');inner.className='detail-inner';
    const preview=createPreview(item,true);const close=document.createElement('button');close.className='detail-close';close.type='button';close.textContent='×';close.setAttribute('aria-label','Close');close.addEventListener('click',()=>dialog.close());preview.append(close);
    for(const [direction,label,symbol] of [[-1,'Previous','‹'],[1,'Next','›']]){const target=index+direction;if(index<0||target<0||target>=state.visible.length)continue;const nav=document.createElement('button');nav.type='button';nav.className=`detail-nav ${direction<0?'prev':'next'}`;nav.textContent=symbol;nav.setAttribute('aria-label',label);nav.addEventListener('click',e=>{e.stopPropagation();stepDetail(direction);});preview.append(nav);}
    let touchX=null,touchY=null;preview.addEventListener('touchstart',e=>{if(e.touches.length===1){touchX=e.touches[0].clientX;touchY=e.touches[0].clientY;}},{passive:true});
    preview.addEventListener('touchend',e=>{if(touchX===null)return;const dx=e.changedTouches[0].clientX-touchX,dy=e.changedTouches[0].clientY-touchY;touchX=null;if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)*1.5)stepDetail(dx<0?1:-1);},{passive:true});
    if(item.kind!=='audio'){preview.classList.add('zoomable');preview.append(chip('⤢','detail-expand',()=>openLightbox(index),'Full screen'));preview.addEventListener('click',e=>{if(item.kind==='image'&&!e.target.closest('button,a,video'))openLightbox(index);});}
    inner.append(preview);
    const form=document.createElement('form');form.className='detail-form';form.addEventListener('submit',e=>e.preventDefault());
    const title=document.createElement('h2');title.textContent=item.name;form.append(title);
    const path=document.createElement('p');path.className='detail-path';const artistName=who(item);if(artistName){path.append(chip(artistName,'detail-artist',()=>navigateTo({type:'artist',artist:artistName},artistName),`Show everything by ${artistName}`),'  ·  ');}path.append([item.folder,prettyBytes(item.size),formatDate(item.modified),item.remote?'On your PC':''].filter(Boolean).join('  ·  '));form.append(path);
    const quick=document.createElement('div');quick.className='detail-quick';
    const fav=chip(isFavorite(item)?'♥ Favorite':'♡ Favorite',`fav-button${isFavorite(item)?' on':''}`,async()=>{const on=await toggleFavorite(item);fav.textContent=on?'♥ Favorite':'♡ Favorite';fav.classList.toggle('on',on);const favId=favoritesFolder()?.id;if(favId)on?memberships.add(favId):memberships.delete(favId);});quick.append(fav);
    const pid=postId(item);if(pid){const link=document.createElement('a');link.className='aryion-link';link.href=`https://aryion.com/g4/view/${pid}`;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Aryion ↗';quick.append(link);}
    form.append(quick);
    if((item.tags||[]).length){const tagRow=document.createElement('div');tagRow.className='detail-tags';for(const tag of item.tags)tagRow.append(chip(`#${tag}`,'detail-tag',e=>openTagMenu(e.currentTarget,tag,item)));form.append(tagRow);}
    const edit=document.createElement('details');edit.className='edit-details';edit.open=!matchMedia('(max-width:560px)').matches;const summary=document.createElement('summary');summary.textContent='Edit artist, tags & notes';edit.append(summary);form.append(edit);
    const creator=makeField(edit,'Artist / creator','text',item.creator||'');
    const tags=makeField(edit,'Tags · separate with commas','text',(item.tags||[]).join(', '));
    const notes=makeField(edit,'Notes','textarea',item.notes||'');
    const cLabel=document.createElement('label');cLabel.className='field-label';cLabel.textContent='Virtual folders';form.append(cLabel);
    const chipArea=document.createElement('div');chipArea.className='detail-collections';const memberships=new Set(item.collectionIds||[]);
    for(const collection of state.collections){const chip=document.createElement('button');chip.type='button';chip.className=`collection-toggle ${memberships.has(collection.id)?'active':''}`;chip.textContent=collection.name;chip.addEventListener('click',()=>{memberships.has(collection.id)?memberships.delete(collection.id):memberships.add(collection.id);chip.classList.toggle('active',memberships.has(collection.id));});chipArea.append(chip);}
    if(!state.collections.length){const no=document.createElement('span');no.className='artist-empty';no.textContent='Create a virtual folder to collect this item.';chipArea.append(no);}form.append(chipArea);
    const actions=document.createElement('div');actions.className='detail-actions';const open=document.createElement('a');open.className='open-original';if(item.remote){open.href='#';open.setAttribute('aria-disabled','true');open.addEventListener('click',e=>{if(open.getAttribute('aria-disabled')){e.preventDefault();showToast('Your PC isn’t connected right now.');}});pcLinkURL('file',item,'&dl=1').then(url=>{open.href=url;open.removeAttribute('aria-disabled');}).catch(()=>{});if(item.kind==='image'){const full=document.createElement('button');full.type='button';full.className='text-button';full.textContent=`Full size (${prettyBytes(item.size)})`;full.addEventListener('click',async()=>{const img=$('.detail-preview img.remote-full');if(!img)return;full.disabled=true;full.textContent='Loading full size…';try{const url=await pcLinkURL('file',item);img.onload=()=>{full.textContent='Showing full size';};img.onerror=()=>{full.disabled=false;full.textContent='Full size didn’t load · retry';};img.src=url;}catch{full.disabled=false;}});actions.append(full);}}else open.href=mediaURL(item);open.download=item.name;open.textContent='Save a copy';actions.prepend(open);
    const save=document.createElement('button');save.type='button';save.className='button primary';save.textContent='Save details';save.addEventListener('click',async()=>{
      item.creator=creator.value.trim();item.tags=[...new Set(tags.value.split(',').map(x=>x.trim()).filter(Boolean))];item.notes=notes.value.trim();item.collectionIds=[...memberships];
      try{let message='Details saved on this device.';if(item.remote)message=pcSavedMessage(await pcSaveEdit(item));else{const promote=state.pc.link?await pcPromoteCollections(item.collectionIds||[]):[];await request('media','put',item);if(promote.length)await pcQueue(promote);}dialog.close();await refreshData(true);showToast(message);}catch(e){showToast(`Could not save: ${e.message}`);}
    });actions.append(save);form.append(actions);inner.append(form);root.append(inner);if(!dialog.open){dialog.showModal();pushOverlay('detail');}
    dialog.onclose=()=>{stopDetailVideos();$$('.tag-menu').forEach(m=>m.remove());$('#detail-content').replaceChildren();releaseDetailMedia();state.detailIndex=-1;closedOverlay('detail');};
  }
  function makeField(parent,label,type,value){
    const l=document.createElement('label');l.className='field-label';l.textContent=label;parent.append(l);
    const el=document.createElement(type==='textarea'?'textarea':'input');if(type!=='textarea')el.type=type;el.value=value;parent.append(el);return el;
  }
  async function importFiles(files,relativePathFor=file=>file.webkitRelativePath||file.name){
    if(state.importBusy)return;const incoming=[...files].map(file=>({file,relative:relativePathFor(file)}));const avatarRecords=incoming.filter(({file})=>/^\.arygrabber-avatar\.img$|^arygrabber-avatar\.(?:jpe?g|png|webp|gif)$/i.test(file.name));const sidecars=incoming.filter(({file})=>/^(?:\.medialib-catalog|\.medialib-library|medialib-catalog)\.json$/i.test(file.name));const accepted=incoming.filter(x=>!avatarRecords.includes(x)&&mediaKind(x.file));
    let sidecarCount=0;if(sidecars.length){try{sidecarCount=await readSidecars(sidecars);}catch{}}
    if(!accepted.length&&!avatarRecords.length){if(sidecarCount){await refreshData(true);showToast('Read AryGrabber’s catalog. Import the media folder to match files.');}else showToast('No supported photos, videos, or audio files found.');return;}
    state.importBusy=true;let avatarsAdded=0;try{avatarsAdded=avatarRecords.length?await importArtistAvatars(avatarRecords):0;}catch(error){state.importBusy=false;showToast(`Could not save artist profile images: ${error.message}`,5000);return;}
    if(!accepted.length){state.importBusy=false;if(avatarsAdded){await refreshData();showToast(`Updated ${avatarsAdded} artist profile ${avatarsAdded===1?'image':'images'}.`);}else showToast('No usable AryGrabber profile images were found.');return;}
    const existing=new Map(state.local.map(x=>[normalizedPath(x.relativePath),x]));const total=accepted.reduce((n,{file,relative})=>{const old=existing.get(normalizedPath(relative));return n+Math.max(0,file.size-(old?.size||0));},0);const estimate=await navigator.storage?.estimate?.().catch(()=>null);const room=estimate?.quota?estimate.quota-estimate.usage:Infinity;
    if(total>room*.9){state.importBusy=false;showToast(`This selection is larger than the browser’s estimated free space (${prettyBytes(Math.max(0,room))}). Choose fewer or smaller files.` ,5000);return;}
    await navigator.storage?.persist?.().catch(()=>false);
    const toast=$('#toast');toast.textContent=`Adding ${accepted.length.toLocaleString()} files…`;toast.classList.add('show');
    let done=0,added=0,finalMessage='',finalTimeout=4000;const batch=[];
    try{
      for(const {file,relative} of accepted){
        const norm=normalizedPath(relative);const prior=existing.get(norm);const legacy=legacyMatch(relative,file.name);
        const parts=relative.split(/[\\/]/).filter(Boolean);const afterRoot=parts.slice(1);let folder=afterRoot.slice(0,-1).join('/');let creator=defaultCreator(relative);
        if(legacy){if(legacy.folder)folder=legacy.folder;if(legacy.creator)creator=legacy.creator;}
        const item={id:prior?.id||crypto.randomUUID(),relativePath:relative,name:file.name,folder,kind:mediaKind(file),size:file.size,modified:file.lastModified||Date.now(),creator:prior?.creator||creator||'',tags:prior?.tags?.length?prior.tags:legacy?.tags||[],notes:prior?.notes||legacy?.notes||'',collectionIds:[...new Set([...(prior?.collectionIds||[]),...(legacy?.collectionIds||[])])],blob:file};
        if(legacy){if(!item.creator)item.creator=legacy.creator||legacy.artist||'';if(!item.tags.length)item.tags=Array.isArray(legacy.tags)?legacy.tags:String(legacy.tags||'').split(',').map(t=>t.trim()).filter(Boolean);if(!item.notes)item.notes=legacy.notes||'';}
        batch.push(item);existing.set(norm,item);done++;
        // One transaction per 20 files is far faster than one per file.
        if(batch.length>=20||done===accepted.length){await writeMany('media',batch);added+=batch.length;batch.length=0;toast.textContent=`Adding ${done.toLocaleString()} of ${accepted.length.toLocaleString()} files…`;}
      }
      await refreshData();finalMessage=`Added ${added.toLocaleString()} files${avatarsAdded?` and updated ${avatarsAdded} artist ${avatarsAdded===1?'profile image':'profile images'}`:''}${sidecarCount?', with AryGrabber’s artists, tags and virtual folders,':''} on this device.`;
    }catch(error){await refreshData();finalMessage=error?.name==='QuotaExceededError'?'Browser storage is full. The files already added are still in your library.':'Import stopped. Files already added are still in your library.';finalTimeout=6000;}
    finally{state.importBusy=false;toast.classList.remove('show');}
    showToast(finalMessage,finalTimeout);
  }
  async function importFolder(){
    if(typeof window.showDirectoryPicker!=='function'){$('#directory-input').click();return;}
    try{
      const root=await window.showDirectoryPicker({mode:'read'}),files=[],paths=new Map();
      async function collect(directory,prefix=''){
        for await(const entry of directory.values()){
          if(entry.kind==='directory')await collect(entry,`${prefix}${entry.name}/`);
          else if(entry.kind==='file'){const file=await entry.getFile();files.push(file);paths.set(file,`${root.name}/${prefix}${entry.name}`);}
        }
      }
      await collect(root);await importFiles(files,file=>paths.get(file)||file.name);
    }catch(error){if(error?.name!=='AbortError')showToast(`Could not open that folder: ${error.message||'folder access failed'}`,5000);}
  }
  async function saveCollection(name){
    name=name.trim();if(!name)return;
    if(state.collections.some(c=>c.name.toLocaleLowerCase()===name.toLocaleLowerCase()&&c.id!==state.editingCollectionId)){showToast('A virtual folder with that name already exists.');return;}
    const previous=state.collections.find(c=>c.id===state.editingCollectionId);const record={id:state.editingCollectionId||crypto.randomUUID(),name,created:previous?.created||Date.now()};
    let where='';if(previous?.remote||(!previous&&state.pc.link)){const sent=await pcQueue([{op:'collection',...record}]);where=sent?' on your PC':' (it will reach your PC when it’s awake)';}else await request('collections','put',record);
    await refreshData(true);showToast(previous?`Renamed folder to “${name}”${where}.`:`Created “${name}”${where}.`);state.editingCollectionId=null;
  }
  function openFolderDialog(collection=null){
    state.editingCollectionId=collection?.id||null;$('#folder-name').value=collection?.name||'';$('#folder-dialog h2').textContent=collection?'Rename virtual folder':'New virtual folder';$('#folder-dialog p').textContent=collection?'Change this folder’s name. The collected media stays in place.':'Collect items here without moving your original files.';$('#create-folder').textContent=collection?'Save name':'Create folder';$('#folder-dialog').showModal();$('#folder-name').focus();
  }
  async function deleteCollection(collection){
    if(!confirm(`Delete the virtual folder “${collection.name}”? Your media files will stay in the library.`))return;
    if(collection.remote)await pcQueue([{op:'delete-collection',id:collection.id}]);else await request('collections','delete',collection.id);if(state.filter.type==='collection'&&state.filter.id===collection.id)state.filter={type:'all'};await refreshData();showToast('Virtual folder deleted. The media was not changed.');
  }
  async function addSelectionToCollection(){
    const id=$('#collection-select').value;if(!id){showToast('Choose a virtual folder first.');return;}
    const updates=[],remotePaths=[];for(const itemId of state.selected){const listed=state.byId.get(itemId);if(listed?.remote){remotePaths.push(listed.relativePath);continue;}const item=await request('media','get',itemId);if(!item)continue;item.collectionIds=[...new Set([...(item.collectionIds||[]),id])];updates.push(item);}
    await writeMany('media',updates);let note='';if(remotePaths.length){const sent=await pcQueue([...await pcPromoteCollections([id]),{op:'add-to-collection',id,paths:remotePaths}]);note=sent?' (saved on your PC)':' (PC items will sync when your PC is awake)';}
    state.selected.clear();updateSelection();await refreshData(true);showToast(`Added ${updates.length+remotePaths.length} items to the virtual folder${note}.`);
  }
  async function importLegacy(file){
    try{
      const json=JSON.parse(await file.text());if(!json||!Array.isArray(json.items))throw new Error('That file is not a MediaLib catalog export.');
      if(Array.isArray(json.collections))for(const collection of json.collections){if(collection.id&&collection.name)await request('collections','put',collection);}
      state.legacy=json.items;indexLegacy();await request('settings','put',{key:'legacyCatalog',value:state.legacy});let count=0;const current=state.local;const changedItems=[];
      for(const item of current){const match=legacyMatch(item.relativePath,item.name);if(!match)continue;let changed=false;
        const creator=String(match.creator||match.artist||'').trim();if(creator&&item.creator!==creator){item.creator=creator;changed=true;}
        const newTags=Array.isArray(match.tags)?match.tags:String(match.tags||'').split(',').map(t=>t.trim()).filter(Boolean);if(!item.tags?.length&&newTags.length){item.tags=newTags;changed=true;}
        if(newTags.length&&JSON.stringify(item.tags)!==JSON.stringify(newTags)){item.tags=newTags;changed=true;}
        if(match.notes&&item.notes!==match.notes){item.notes=match.notes;changed=true;}
        if(match.folder&&item.folder!==match.folder){item.folder=match.folder;changed=true;}
        if((match.collectionIds||[]).length){const merged=[...new Set([...(item.collectionIds||[]),...match.collectionIds])];if(merged.length!==(item.collectionIds||[]).length){item.collectionIds=merged;changed=true;}}
        if(changed){changedItems.push(item);count++;}
        if(changedItems.length>=50)await writeMany('media',changedItems.splice(0));
      }
      if(changedItems.length)await writeMany('media',changedItems);
      await refreshData(true);
      showToast(count?`Restored details for ${count} matching files.`:`Catalog loaded. Add the matching media folder to connect its details.`,6000);
    }catch(e){showToast(e.message||'Could not read that catalog export.',5000);}
  }
  function exportCatalog(){
    const payload={schema:'medialib-catalog-v1',exportedAt:new Date().toISOString(),collections:state.collections,items:state.all.map(item=>({path:item.relativePath,name:item.name,folder:item.folder,kind:item.kind,size:item.size,modified:item.modified,creator:item.creator,tags:item.tags,notes:item.notes,collectionIds:item.collectionIds||[]}))};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='MediaLib-catalog.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);showToast('Catalog metadata exported. Media files are not included.');
  }
  async function exportFullLibrary(){
    const media=state.local,avatarRecords=Object.entries(state.artistAvatars),localAvatars=avatarRecords.filter(([,record])=>record.blob);
    if(!media.length&&!avatarRecords.length){showToast('There are no media files or artist avatars in this library to export.');return;}
    if(media.length+localAvatars.length+1>65535||media.some(item=>item.blob.size>=0xffffffff)||localAvatars.some(([,record])=>record.blob.size>=0xffffffff)){showToast('This library is too large for the current archive format.',5000);return;}
    const toast=$('#toast');toast.textContent=`Preparing full-library archive · 0 of ${media.length} files`;toast.classList.add('show');
    const files=media.map((item,index)=>({item,name:`media/${String(index+1).padStart(6,'0')}-${encodeURIComponent(item.name)}`}));
    const avatarFiles=localAvatars.map(([key,record],index)=>({key,record,name:`artists/${String(index+1).padStart(4,'0')}-${encodeURIComponent(record.name||key)}`}));
    const catalog={schema:'medialib-full-library-v1',exportedAt:new Date().toISOString(),collections:state.collections,artistAvatars:avatarRecords.map(([key,record])=>({key,name:record.name||key,url:record.url||'',bundlePath:record.blob?avatarFiles.find(x=>x.key===key)?.name:''})),items:files.map(({item,name})=>({id:item.id,path:item.relativePath,relativePath:item.relativePath,name:item.name,folder:item.folder,kind:item.kind,size:item.size,modified:item.modified,creator:item.creator,tags:item.tags||[],notes:item.notes||'',collectionIds:item.collectionIds||[],bundlePath:name}))};
    const metadataBlob=new Blob([JSON.stringify(catalog)],{type:'application/json'});const entries=[{name:'MediaLib-library.json',blob:metadataBlob},...files.map(x=>({name:x.name,blob:x.item.blob})),...avatarFiles.map(x=>({name:x.name,blob:x.record.blob}))];
    let finalMessage='',finalTimeout=6000;
    try{
      const archive=await MediaLibArchive.createArchive(entries,(done,total,bytes)=>{if(done%8===1||done===total)toast.textContent=`Preparing full-library archive · ${done.toLocaleString()} of ${total.toLocaleString()} files · ${prettyBytes(bytes)}`;});
      const url=URL.createObjectURL(archive),a=document.createElement('a');a.href=url;a.download=`MediaLib-library-${new Date().toISOString().slice(0,10)}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);finalMessage=`Exported ${media.length} media files, ${avatarRecords.length} artist avatars, and catalog. Keep the archive private.`;
    }catch(error){finalMessage=`Library export stopped: ${error.message}`;finalTimeout=7000;}
    finally{toast.classList.remove('show');}
    showToast(finalMessage,finalTimeout);
  }
  function clearStore(name){return new Promise((resolve,reject)=>{const tx=state.db.transaction(name,'readwrite');tx.objectStore(name).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Library clear failed'));});}
  async function clearLibraryData(){revokeUrls(true);for(const id of [...state.thumbUrls.keys()])dropThumbUrl(id);state.thumbs.clear();state.thumbQueue=[];state.thumbQueued.clear();state.thumbFailed.clear();await Promise.all(['media','collections','settings','thumbs'].map(clearStore));state.legacy=[];indexLegacy();state.artistAvatars={};state.avatarLookups.clear();pcReset();renderPcStatus();state.filter={type:'home'};state.kind='image';state.query='';$('#search').value='';$('#page-title').textContent='Browse library';}
  async function importFullLibrary(file){
    const toast=$('#toast');toast.textContent='Reading library archive…';toast.classList.add('show');let finalMessage='',finalTimeout=6000;
    try{
      const {catalog,entries}=await MediaLibArchive.parseArchive(file,(done,total)=>{$('#toast').textContent=`Checking library archive · ${done} of ${total} files`;});const total=catalog.items.reduce((n,x)=>n+(x.size||0),0)+(catalog.artistAvatars||[]).reduce((n,x)=>n+(x.bundlePath?entries.get(x.bundlePath)?.blob.size||0:0),0);const estimate=await navigator.storage?.estimate?.().catch(()=>null);
      if(estimate?.quota&&total>estimate.quota)throw new Error(`Archive is ${prettyBytes(total)}; browser storage estimate is ${prettyBytes(estimate.quota)}.`);
      if(!confirm(`Replace this device’s current MediaLib with ${catalog.items.length.toLocaleString()} items (${prettyBytes(total)}) from this archive? The current browser copy and virtual folders will be replaced; original files elsewhere are unchanged.`))return;
      await clearLibraryData();
      for(const collection of catalog.collections||[])await request('collections','put',collection);
      for(const avatar of catalog.artistAvatars||[]){if(!avatar.key)continue;const blob=avatar.bundlePath?entries.get(avatar.bundlePath)?.blob:null;state.artistAvatars[avatar.key]={name:avatar.name||avatar.key,...(blob?{blob,source:'archive'}:avatar.url?{url:avatar.url,source:'aryion'}:{})};}
      if(Object.keys(state.artistAvatars).length)await request('settings','put',{key:'artistAvatars',value:state.artistAvatars});
      const batch=[];
      for(let i=0;i<catalog.items.length;i++){
        const item=catalog.items[i],entry=entries.get(item.bundlePath),blob=entry.blob;
        batch.push({id:item.id||crypto.randomUUID(),relativePath:item.relativePath||item.path||item.name,name:item.name,folder:item.folder||'',kind:item.kind||'image',size:item.size||blob.size,modified:item.modified||Date.now(),creator:item.creator||item.artist||'',tags:Array.isArray(item.tags)?item.tags:String(item.tags||'').split(',').map(x=>x.trim()).filter(Boolean),notes:item.notes||'',collectionIds:item.collectionIds||[],blob});
        if(batch.length>=25||i===catalog.items.length-1){await writeMany('media',batch.splice(0));toast.textContent=`Importing library · ${i+1} of ${catalog.items.length} files`;}
      }
      await request('settings','put',{key:'welcomeSeen',value:true});await refreshData();finalMessage=`Imported ${catalog.items.length.toLocaleString()} media files and virtual folders.`;
    }catch(error){finalMessage=`Library import stopped: ${error.message}`;finalTimeout=7000;try{await refreshData();}catch{}}
    finally{toast.classList.remove('show');}
    showToast(finalMessage,finalTimeout);
  }
  async function deleteLibrary(){
    if(!state.all.length&&!state.collections.length&&!Object.keys(state.artistAvatars).length){showToast('This library is already empty.');return;}
    if(!confirm(`Delete this MediaLib library from this device? This removes ${state.all.length.toLocaleString()} local media copies, tags, notes, ${Object.keys(state.artistAvatars).length} artist profile images, and virtual folders. Original files outside MediaLib are not deleted.`))return;
    await clearLibraryData();await request('settings','put',{key:'welcomeSeen',value:true});await refreshData();$('#manage-dialog').close();showToast('This device now has a new, empty library.');
  }
  // ---- Artists: one entry per artist, whatever the capitalization ---------
  // AryGrabber folders are lower-case while Aryion names aren't, so the same
  // artist could show up twice. The most common spelling is shown.
  function ak(name){return String(name||'').trim().toLocaleLowerCase();}
  function who(item){return state.artistNames.get(ak(item.creator))||'';}
  function artistDisplay(name){return state.artistNames.get(ak(name))||String(name||'');}
  function buildArtistNames(){
    const casings=new Map();
    for(const item of state.all){const name=String(item.creator||'').trim();if(!name)continue;const key=name.toLocaleLowerCase();let m=casings.get(key);if(!m)casings.set(key,m=new Map());m.set(name,(m.get(name)||0)+1);}
    state.artistNames=new Map();
    for(const [key,m] of casings){let best='',score=-1;for(const [name,count] of m){const s=count+(name!==name.toLocaleLowerCase()?.5:0);if(s>score){score=s;best=name;}}state.artistNames.set(key,best);}
  }
  const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});

  // ---- Search syntax and tag refinement ------------------------------------
  // Search box: plain words, #tag (or #"two words" / #two_words), -#tag to
  // hide, -word, @artist or artist:name. Tags picked from the strip or the
  // Tags panel stack on top of whatever view you're in (artist, folder, tag…).
  const tagCache=new WeakMap();
  function tagsLower(item){let s=tagCache.get(item);if(!s||s.src!==item.tags){s=new Set((item.tags||[]).map(t=>String(t).toLocaleLowerCase()));s.src=item.tags;tagCache.set(item,s);}return s;}
  function hasTag(item,tag){return tagsLower(item).has(String(tag).toLocaleLowerCase());}
  function parseQuery(text){
    const q={words:[],nots:[],tags:[],notTags:[],artist:''};const re=/(-?)(#|tag:|artist:|@)?("([^"]*)"?|\S+)/gi;let m;
    while((m=re.exec(String(text||'')))){
      const neg=m[1]==='-',prefix=(m[2]||'').toLocaleLowerCase(),value=String(m[4]??m[3]).replace(/^"|"$/g,'').trim().toLocaleLowerCase();
      if(!value)continue;
      if(prefix==='#'||prefix==='tag:')(neg?q.notTags:q.tags).push(value.replaceAll('_',' '));
      else if(prefix==='@'||prefix==='artist:')q.artist=value.replaceAll('_',' ');
      else (neg?q.nots:q.words).push(value);
    }
    return q;
  }
  function hasQuery(){return !!(state.query||state.refine.tags.length||state.refine.not.length);}
  function matchesQuery(item){
    const q=state.q,r=state.refine;
    for(const t of r.tags)if(!hasTag(item,t))return false;
    for(const t of r.not)if(hasTag(item,t))return false;
    if(q.artist&&!ak(item.creator).includes(q.artist))return false;
    if(q.tags.length||q.notTags.length){const tl=[...tagsLower(item)];for(const t of q.tags)if(!tl.some(x=>x.includes(t)))return false;for(const t of q.notTags)if(tl.some(x=>x.includes(t)))return false;}
    if(q.words.length||q.nots.length){const hay=[item.name,item.title,item.creator,who(item),item.folder,item.notes,...(item.tags||[])].join(' ').toLocaleLowerCase();for(const w of q.words)if(!hay.includes(w))return false;for(const w of q.nots)if(hay.includes(w))return false;}
    return true;
  }
  function hashString(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  function sortKeyName(item){return item.title||String(item.name||'').replace(/^\d+\s+/,'');}
  function sortVisible(list){
    const s=state.sort;
    if(s==='oldest')list.sort((a,b)=>(a.modified||0)-(b.modified||0));
    else if(s==='name')list.sort((a,b)=>collator.compare(sortKeyName(a),sortKeyName(b)));
    else if(s==='artist')list.sort((a,b)=>collator.compare(who(a)||'~',who(b)||'~')||(b.modified||0)-(a.modified||0));
    else if(s==='random'){const h=new Map(list.map(x=>[x,hashString(x.id+state.shuffleSeed)]));list.sort((a,b)=>h.get(a)-h.get(b));}
    else if(s==='largest')list.sort((a,b)=>(b.size||0)-(a.size||0));
    else list.sort((a,b)=>(b.modified||0)-(a.modified||0));
  }
  function scopeName(){const f=state.filter;if(f.type==='artist')return artistDisplay(f.artist)||'Unassigned';if(f.type==='artist-folder')return `${artistDisplay(f.artist)} / ${f.folder||'Unorganized'}`;if(f.type==='collection')return state.collections.find(c=>c.id===f.id)?.name||'this folder';if(f.type==='tag')return `#${f.tag}`;return '';}
  function chip(label,className,onClick,title=''){const b=document.createElement('button');b.type='button';b.className=className;b.textContent=label;if(title)b.title=title;b.addEventListener('click',e=>{e.stopPropagation();onClick(e);});return b;}
  function addRefine(tag,exclude=false){
    const r=state.refine,low=String(tag).toLocaleLowerCase();
    if(state.filter.type==='tag'&&state.filter.tag.toLocaleLowerCase()===low&&!exclude)return;
    if(state.filter.type==='home'){setFilter({type:'all'},'All media',{refine:{tags:exclude?[]:[tag],not:exclude?[tag]:[]},kind:'all'});return;}
    r.tags=r.tags.filter(t=>t.toLocaleLowerCase()!==low);r.not=r.not.filter(t=>t.toLocaleLowerCase()!==low);(exclude?r.not:r.tags).push(tag);commitView();
  }
  function removeRefine(tag){const low=String(tag).toLocaleLowerCase();state.refine.tags=state.refine.tags.filter(t=>t.toLocaleLowerCase()!==low);state.refine.not=state.refine.not.filter(t=>t.toLocaleLowerCase()!==low);commitView();}
  function renderRefine(){
    const row=$('#refine-row'),strip=$('#tag-strip');if(!row)return;row.replaceChildren();strip.replaceChildren();const r=state.refine,f=state.filter;
    for(const t of r.tags)row.append(chip(`#${t}  ×`,'refine-chip',()=>removeRefine(t),'Remove this tag filter'));
    for(const t of r.not)row.append(chip(`−${t}  ×`,'refine-chip exclude',()=>removeRefine(t),'Stop hiding this tag'));
    if(r.tags.length+r.not.length>1)row.append(chip('Clear','text-button',()=>{state.refine={tags:[],not:[]};commitView();}));
    row.hidden=!row.children.length;
    if(f.type==='home'&&!hasQuery()){strip.hidden=true;return;}
    const chosen=new Set([...r.tags,...r.not,f.type==='tag'?f.tag:''].map(x=>x.toLocaleLowerCase()));const counts=new Map();
    for(const item of state.visible)for(const t of item.tags||[])if(!chosen.has(t.toLocaleLowerCase()))counts.set(t,(counts.get(t)||0)+1);
    const scoped=f.type==='artist'||f.type==='artist-folder'||f.type==='collection';
    const label=document.createElement('span');label.className='strip-label';label.textContent=scoped?`Tags in ${scopeName()}`:'Narrow down';strip.append(label);
    strip.append(chip('# All tags…','strip-chip strong',()=>openTagSheet()));
    if((f.type==='tag'||r.tags.length)&&!scoped){
      const artists=new Map();for(const item of state.visible){const name=who(item);if(name)artists.set(name,(artists.get(name)||0)+1);}
      const tags=f.type==='tag'?[f.tag,...r.tags]:[...r.tags];
      for(const [name,count] of [...artists].sort((a,b)=>b[1]-a[1]).slice(0,12))if(artists.size>1)strip.append(chip(`♙ ${name} ${count}`,'strip-chip artist',()=>setFilter({type:'artist',artist:name},name,{refine:{tags,not:[...r.not]}}),`Only ${tags.map(t=>'#'+t).join(' ')} by ${name}`));
    }
    for(const [tag,count] of [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,30))if(count<state.visible.length)strip.append(chip(`${tag} ${count}`,'strip-chip',()=>addRefine(tag)));
    strip.hidden=strip.children.length<=2&&!counts.size;
  }

  // ---- Tags panel ------------------------------------------------------------
  function openTagSheet(scope){
    const f=state.filter,canScope=!['home','all'].includes(f.type);
    state.sheetScope=scope||(canScope?'here':'all');state.sheetDirty=false;
    $('#scope-here').hidden=!canScope;$('#scope-here').textContent=canScope?`In ${scopeName()}`:'';
    $('#tag-sheet-search').value='';renderTagSheet();
    const sheet=$('#tag-sheet');if(!sheet.open){sheet.showModal();pushOverlay('tags');}
    if(!matchMedia('(pointer:coarse)').matches)$('#tag-sheet-search').focus();
  }
  function renderTagSheet(){
    const here=state.sheetScope==='here',r=state.refine,query=$('#tag-sheet-search').value.trim().toLocaleLowerCase();
    $$('#tag-scope button').forEach(b=>b.classList.toggle('active',b.dataset.scope===state.sheetScope));
    const base=here?state.visible:state.all.filter(x=>r.tags.every(t=>hasTag(x,t))&&!r.not.some(t=>hasTag(x,t)));
    const counts=new Map();for(const item of base)for(const t of item.tags||[])counts.set(t,(counts.get(t)||0)+1);
    const chosen=new Set(r.tags.map(t=>t.toLocaleLowerCase())),hidden=new Set(r.not.map(t=>t.toLocaleLowerCase()));
    for(const t of [...r.tags,...r.not])if(![...counts.keys()].some(k=>k.toLocaleLowerCase()===t.toLocaleLowerCase()))counts.set(t,0);
    let rows=[...counts].filter(([t])=>!query||t.toLocaleLowerCase().includes(query));
    rows.sort((a,b)=>{const pa=chosen.has(a[0].toLocaleLowerCase())||hidden.has(a[0].toLocaleLowerCase())?1:0,pb=chosen.has(b[0].toLocaleLowerCase())||hidden.has(b[0].toLocaleLowerCase())?1:0;return pb-pa||b[1]-a[1]||a[0].localeCompare(b[0]);});
    const list=$('#tag-sheet-list');list.replaceChildren();
    $('#tag-sheet-count').textContent=`${rows.length.toLocaleString()} ${rows.length===1?'tag':'tags'} · ${base.length.toLocaleString()} items${here?` in ${scopeName()}`:' everywhere'}`;
    const frag=document.createDocumentFragment();
    for(const [tag,count] of rows.slice(0,400)){
      const low=tag.toLocaleLowerCase(),row=document.createElement('div');row.className=`sheet-row${chosen.has(low)?' on':''}${hidden.has(low)?' off':''}`;
      const pick=chip('', 'sheet-pick',()=>sheetToggle(tag,false));const mark=document.createElement('span');mark.className='sheet-mark';mark.textContent=chosen.has(low)?'✓':hidden.has(low)?'−':'#';const name=document.createElement('span');name.className='sheet-name';name.textContent=tag;const n=document.createElement('span');n.className='sheet-count';n.textContent=count.toLocaleString();pick.append(mark,name,n);
      const hide=chip(hidden.has(low)?'↺':'−','sheet-hide',()=>sheetToggle(tag,true),hidden.has(low)?'Stop hiding':'Hide items with this tag');
      row.append(pick,hide);frag.append(row);
    }
    if(rows.length>400){const more=document.createElement('p');more.className='sheet-more';more.textContent=`Showing the top 400. Type to find others.`;frag.append(more);}
    if(!rows.length){const none=document.createElement('p');none.className='sheet-more';none.textContent='No tags match.';frag.append(none);}
    list.append(frag);
  }
  function sheetToggle(tag,exclude){
    const r=state.refine,low=tag.toLocaleLowerCase(),inc=r.tags.some(t=>t.toLocaleLowerCase()===low),exc=r.not.some(t=>t.toLocaleLowerCase()===low);
    r.tags=r.tags.filter(t=>t.toLocaleLowerCase()!==low);r.not=r.not.filter(t=>t.toLocaleLowerCase()!==low);
    if(exclude&&!exc)r.not.push(tag);else if(!exclude&&!inc)r.tags.push(tag);
    if(state.sheetScope==='all'&&!['all'].includes(state.filter.type)){state.filter={type:'all'};state.kind='all';$('#page-title').textContent='All media';$$('.filter-chip').forEach(b=>b.classList.toggle('active',b.dataset.kind==='all'));renderSidebar();updateHeading();}
    state.sheetDirty=true;applyFilter();renderTagSheet();
  }

  // ---- Back button / history ----------------------------------------------
  // The phone's back gesture closes the viewer, panels and steps back through
  // the views you opened, instead of leaving the app.
  const nav={stack:[],ignore:0,after:null,restoring:false};
  function snapshot(){return {filter:state.filter,title:$('#page-title').textContent,kind:state.kind,refine:{tags:[...state.refine.tags],not:[...state.refine.not]},query:state.query};}
  function saveView(){try{localStorage.setItem('medialib-view',JSON.stringify(snapshot()));}catch{}}
  function pushView(){if(nav.restoring)return;history.pushState({view:snapshot()},'');saveView();}
  function replaceView(){if(!nav.stack.length)history.replaceState({view:snapshot()},'');saveView();}
  function commitView(){applyFilter();pushView();}
  function restoreView(view){
    if(!view?.filter)return;nav.restoring=true;
    try{state.filter=view.filter;state.kind=view.kind||'image';state.refine={tags:[...(view.refine?.tags||[])],not:[...(view.refine?.not||[])]};state.query=view.query||'';$('#search').value=state.query;$('#page-title').textContent=view.title||'Browse library';$$('.filter-chip').forEach(b=>b.classList.toggle('active',b.dataset.kind===state.kind));renderSidebar();updateHeading();applyFilter();saveView();}
    finally{nav.restoring=false;}
  }
  function pushOverlay(name){nav.stack.push(name);history.pushState({overlay:name},'');}
  function closedOverlay(name,then=null){
    const index=nav.stack.lastIndexOf(name);if(index<0){if(then)then();return;}
    const steps=nav.stack.length-index;nav.stack.length=index;nav.ignore++;if(then)nav.after=then;history.go(-steps);
  }
  function closeAllOverlays(then){
    const steps=nav.stack.length;nav.stack=[];
    for(const id of ['lightbox','tag-sheet','detail-dialog']){const d=$(`#${id}`);if(d?.open)d.close();}
    if(steps){nav.ignore++;nav.after=then||null;history.go(-steps);}else if(then)then();
  }
  function navigateTo(filter,title,opts){closeAllOverlays(()=>setFilter(filter,title,opts));}
  function onPopState(event){
    if(nav.ignore){nav.ignore--;if(!nav.ignore&&nav.after){const fn=nav.after;nav.after=null;fn();}return;}
    const top=nav.stack.pop();
    if(top){const d=$(top==='detail'?'#detail-dialog':top==='lightbox'?'#lightbox':'#tag-sheet');if(d?.open)d.close();return;}
    $$('dialog[open]').forEach(d=>d.close());
    if(event.state?.view)restoreView(event.state.view);
  }
  function navInit(){
    if(history.state?.overlay||!history.state?.view)history.replaceState({view:snapshot()},'');
    window.addEventListener('popstate',onPopState);
  }
  function loadSavedView(){
    try{const view=JSON.parse(localStorage.getItem('medialib-view')||'null');if(view?.filter&&view.filter.type!=='home'){state.filter=view.filter;state.kind=view.kind||'all';state.refine={tags:[...(view.refine?.tags||[])],not:[...(view.refine?.not||[])]};state.query=view.query||'';$('#search').value=state.query;$('#page-title').textContent=view.title||'All media';$$('.filter-chip').forEach(b=>b.classList.toggle('active',b.dataset.kind===state.kind));}}catch{}
    try{state.density=localStorage.getItem('medialib-density')||'normal';const sort=localStorage.getItem('medialib-sort');if(sort){state.sort=sort;$('#sort-select').value=sort;}}catch{}
    applyDensity();
  }

  // ---- Grid size ----------------------------------------------------------
  const DENSITIES=[['large','Large tiles'],['normal','Normal tiles'],['small','Small tiles'],['tiny','Tiny tiles']];
  function applyDensity(){const g=$('#gallery');for(const [d] of DENSITIES)g.classList.toggle(`dens-${d}`,state.density===d);const label=DENSITIES.find(d=>d[0]===state.density)?.[1]||'';$('#density-button').title=`${label} · tap to change`;$('#density-button').setAttribute('aria-label',`Grid size: ${label}`);}
  function cycleDensity(){const i=DENSITIES.findIndex(d=>d[0]===state.density);state.density=DENSITIES[(i+1)%DENSITIES.length][0];try{localStorage.setItem('medialib-density',state.density);}catch{}applyDensity();showToast(DENSITIES.find(d=>d[0]===state.density)[1],1200);}

  // ---- Favorites -----------------------------------------------------------
  function favoritesFolder(){return state.collections.find(c=>c.name.toLocaleLowerCase()==='favorites');}
  function isFavorite(item){const fav=favoritesFolder();return !!fav&&(item.collectionIds||[]).includes(fav.id);}
  async function toggleFavorite(item){
    let fav=favoritesFolder();const ops=[];
    if(!fav){fav={id:crypto.randomUUID(),name:'Favorites',created:Date.now(),remote:!!state.pc.link};if(state.pc.link)ops.push({op:'collection',id:fav.id,name:fav.name,created:fav.created});else await request('collections','put',{id:fav.id,name:fav.name,created:fav.created});}
    const on=!(item.collectionIds||[]).includes(fav.id);item.collectionIds=on?[...(item.collectionIds||[]),fav.id]:(item.collectionIds||[]).filter(id=>id!==fav.id);
    if(item.remote){ops.push(...await pcPromoteCollections([fav.id]),{op:'item',path:item.relativePath,collectionIds:item.collectionIds});}
    else{if(state.pc.link&&!fav.remote)ops.push(...await pcPromoteCollections([fav.id]));const stored=await request('media','get',item.id);if(stored){stored.collectionIds=item.collectionIds;await request('media','put',stored);}}
    if(ops.length)await pcQueue(ops);
    await refreshData(true);showToast(on?'Added to Favorites ♥':'Removed from Favorites',1500);return on;
  }
  function postId(item){return /^(\d{3,})(?:\D|$)/.exec(item.name||'')?.[1]||'';}

  // ---- Full-screen viewer -------------------------------------------------
  // Pinch or double-tap to zoom, drag to pan, swipe sideways for the next
  // item, swipe down (or tap ×) to close. Mouse: wheel zooms, drag pans.
  const lb={index:-1,scale:1,x:0,y:0,touch:null,lastTap:0,tapTimer:0,token:0};
  function lbMedia(){return $('#lb-stage .lb-media');}
  function lbBounds(){const m=lbMedia(),st=$('#lb-stage');if(!m)return{mx:0,my:0};return{mx:Math.max(0,(m.clientWidth*lb.scale-st.clientWidth)/2),my:Math.max(0,(m.clientHeight*lb.scale-st.clientHeight)/2)};}
  function lbApply(animate=false,clamp=true){
    const m=lbMedia();if(!m)return;if(lb.scale<=1.001&&clamp){lb.scale=1;lb.x=0;lb.y=0;}
    if(clamp){const b=lbBounds();lb.x=Math.max(-b.mx,Math.min(b.mx,lb.x));lb.y=Math.max(-b.my,Math.min(b.my,lb.y));}
    m.style.transition=animate?'transform .2s ease':'none';m.style.transform=`translate3d(${lb.x}px,${lb.y}px,0) scale(${lb.scale})`;$('#lightbox').classList.toggle('zoomed',lb.scale>1);
  }
  function lbPoint(x,y){const r=$('#lb-stage').getBoundingClientRect();return[x-r.left-r.width/2,y-r.top-r.height/2];}
  function lbZoomAt(px,py,scale,animate){scale=Math.max(1,Math.min(8,scale));const k=scale/lb.scale;lb.x=px-(px-lb.x)*k;lb.y=py-(py-lb.y)*k;lb.scale=scale;lbApply(animate);}
  function openLightbox(index){
    const item=state.visible[index];if(!item||item.kind==='audio')return;
    const box=$('#lightbox');if(!box.open){box.showModal();pushOverlay('lightbox');}box.classList.remove('hide-chrome');lbShow(index);
  }
  function lbClear(){for(const el of $$('#lb-stage .lb-media,#lb-stage .lb-thumb')){if(el.tagName==='VIDEO'){try{el.pause();el.removeAttribute('src');el.load();}catch{}}el.remove();}}
  async function lbShow(index){
    const item=state.visible[index];if(!item)return;const token=++lb.token;lb.index=index;lb.scale=1;lb.x=0;lb.y=0;lbClear();
    const stage=$('#lb-stage'),status=$('#lb-status');
    $('#lb-count').textContent=`${(index+1).toLocaleString()} / ${state.visible.length.toLocaleString()}`;$('#lb-title').textContent=item.title||item.name;
    $('#lb-prev').hidden=index<=0;$('#lb-next').hidden=index>=state.visible.length-1;
    $('#lb-hd').hidden=!(item.remote&&item.kind==='image');$('#lb-hd').textContent='HD';$('#lb-hd').disabled=false;
    $('#lb-fav').textContent=isFavorite(item)?'♥':'♡';$('#lb-fav').classList.toggle('on',isFavorite(item));
    const thumb=thumbURL(item);if(thumb){const t=document.createElement('img');t.className='lb-thumb';t.src=thumb;t.alt='';stage.append(t);}
    const media=document.createElement(item.kind==='video'?'video':'img');media.className='lb-media';
    if(item.kind==='video'){media.controls=true;media.playsInline=true;media.preload='metadata';if(thumb)media.poster=thumb;}else{media.alt=item.name;media.draggable=false;media.decoding='async';}
    status.hidden=false;status.textContent='Loading…';
    const ready=()=>{if(token!==lb.token)return;status.hidden=true;$$('#lb-stage .lb-thumb').forEach(x=>x.remove());lbApply();};
    media.addEventListener(item.kind==='video'?'loadedmetadata':'load',ready);
    media.onerror=()=>{if(token!==lb.token)return;status.hidden=false;status.textContent=item.remote?'Couldn’t load this from your PC. It may be asleep, or Tailscale is off.':'Couldn’t show this file.';};
    stage.append(media);
    try{media.src=item.remote?await pcLinkURL(item.kind==='image'?'view':'file',item):mediaURL(item);}catch{media.onerror();}
    const next=state.visible[index+1];
    if(next&&next.kind==='image')(next.remote?pcLinkURL('view',next):Promise.resolve(mediaURL(next))).then(url=>{const pre=new Image();pre.decoding='async';pre.src=url;}).catch(()=>{});
  }
  function lbStep(direction){const next=lb.index+direction;if(next<0||next>=state.visible.length)return;if(next>=state.page*PAGE_SIZE)renderPage(false);lbShow(next);}
  async function lbHD(){
    const item=state.visible[lb.index],m=lbMedia();if(!item?.remote||!m)return;const button=$('#lb-hd');button.disabled=true;button.textContent='…';
    const url=await pcLinkURL('file',item).catch(()=>'');if(!url){button.disabled=false;button.textContent='HD';return;}
    const full=new Image();full.onload=()=>{if(lbMedia()===m){m.src=url;button.textContent='HD ✓';}};full.onerror=()=>{button.disabled=false;button.textContent='HD';showToast('Full size didn’t load.');};full.src=url;
  }
  function lbToggleChrome(){$('#lightbox').classList.toggle('hide-chrome');}
  function lbSetupGestures(){
    const stage=$('#lb-stage'),box=$('#lightbox');
    stage.addEventListener('touchstart',e=>{
      const m=lbMedia();if(m?.tagName==='VIDEO'&&e.target===m)return;
      if(e.touches.length===2){const [a,b]=e.touches;lb.touch={mode:'pinch',dist:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)||1,scale:lb.scale,mid:lbPoint((a.clientX+b.clientX)/2,(a.clientY+b.clientY)/2),x:lb.x,y:lb.y};}
      else if(e.touches.length===1){const p=e.touches[0];lb.touch={mode:lb.scale>1?'pan':'swipe',sx:p.clientX,sy:p.clientY,x:lb.x,y:lb.y,moved:false};}
    },{passive:true});
    stage.addEventListener('touchmove',e=>{
      const t=lb.touch;if(!t)return;e.preventDefault();
      if(t.mode==='pinch'&&e.touches.length>=2){const [a,b]=e.touches;const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);const mid=lbPoint((a.clientX+b.clientX)/2,(a.clientY+b.clientY)/2);const s=Math.max(.6,Math.min(8,t.scale*d/t.dist));const k=s/t.scale;lb.scale=s;lb.x=t.mid[0]-(t.mid[0]-t.x)*k+(mid[0]-t.mid[0]);lb.y=t.mid[1]-(t.mid[1]-t.y)*k+(mid[1]-t.mid[1]);lbApply(false,false);return;}
      const p=e.touches[0];const dx=p.clientX-t.sx,dy=p.clientY-t.sy;if(Math.abs(dx)>8||Math.abs(dy)>8)t.moved=true;
      if(t.mode==='pan'){lb.x=t.x+dx;lb.y=t.y+dy;lbApply();}
      else if(t.mode==='swipe'&&t.moved){const m=lbMedia();if(!m)return;if(t.axis===undefined)t.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';m.style.transition='none';if(t.axis==='x')m.style.transform=`translate3d(${dx}px,0,0)`;else{m.style.transform=`translate3d(0,${Math.max(0,dy)}px,0) scale(${1-Math.min(.25,Math.max(0,dy)/1200)})`;box.style.setProperty('--lb-fade',String(Math.max(.25,1-Math.max(0,dy)/400)));}}
    },{passive:false});
    stage.addEventListener('touchend',e=>{
      const t=lb.touch;if(!t)return;
      if(t.mode==='pinch'){if(e.touches.length===1){const p=e.touches[0];lb.touch={mode:'pan',sx:p.clientX,sy:p.clientY,x:lb.x,y:lb.y,moved:true};return;}lb.touch=null;lbApply(true);return;}
      lb.touch=null;const p=e.changedTouches[0],dx=p.clientX-t.sx,dy=p.clientY-t.sy;box.style.removeProperty('--lb-fade');
      if(!t.moved){
        const now=Date.now(),[px,py]=lbPoint(p.clientX,p.clientY);
        if(now-lb.lastTap<320){lb.lastTap=0;clearTimeout(lb.tapTimer);if(lb.scale>1){lb.scale=1;lbApply(true);}else lbZoomAt(px,py,2.5,true);}
        else{lb.lastTap=now;clearTimeout(lb.tapTimer);lb.tapTimer=setTimeout(lbToggleChrome,330);}
        return;
      }
      if(t.mode==='swipe'){if(t.axis==='x'&&Math.abs(dx)>60)lbStep(dx<0?1:-1);else if(t.axis==='y'&&dy>110){box.close();return;}else lbApply(true);}
    });
    stage.addEventListener('wheel',e=>{if(lbMedia()?.tagName!=='IMG')return;e.preventDefault();const [px,py]=lbPoint(e.clientX,e.clientY);lbZoomAt(px,py,lb.scale*(e.deltaY<0?1.2:1/1.2),false);},{passive:false});
    stage.addEventListener('dblclick',e=>{if(lbMedia()?.tagName!=='IMG')return;const [px,py]=lbPoint(e.clientX,e.clientY);if(lb.scale>1){lb.scale=1;lbApply(true);}else lbZoomAt(px,py,2.5,true);});
    let drag=null;
    stage.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse'||lb.scale<=1)return;drag={sx:e.clientX,sy:e.clientY,x:lb.x,y:lb.y};stage.setPointerCapture(e.pointerId);});
    stage.addEventListener('pointermove',e=>{if(!drag)return;lb.x=drag.x+e.clientX-drag.sx;lb.y=drag.y+e.clientY-drag.sy;lbApply();});
    stage.addEventListener('pointerup',()=>{drag=null;});
    stage.addEventListener('click',e=>{if(e.pointerType==='mouse'&&e.target===stage&&lb.scale<=1)box.close();});
    $('#lb-close').addEventListener('click',()=>box.close());
    $('#lb-prev').addEventListener('click',()=>lbStep(-1));$('#lb-next').addEventListener('click',()=>lbStep(1));
    $('#lb-hd').addEventListener('click',lbHD);
    $('#lb-fav').addEventListener('click',async()=>{const item=state.visible[lb.index];if(!item)return;const on=await toggleFavorite(item);$('#lb-fav').textContent=on?'♥':'♡';$('#lb-fav').classList.toggle('on',on);});
    $('#lb-info').addEventListener('click',()=>box.close());
    window.addEventListener('resize',()=>{if(box.open)lbApply();});
    box.addEventListener('close',()=>{
      lbClear();clearTimeout(lb.tapTimer);
      const index=lb.index;lb.index=-1;
      if($('#detail-dialog').open&&index>=0&&index!==state.detailIndex&&state.visible[index])openDetail(state.visible[index],index);
      closedOverlay('lightbox');
    });
  }

  // ---- Tag menu inside the viewer -----------------------------------------
  function openTagMenu(anchor,tag,item){
    $$('.tag-menu').forEach(m=>m.remove());
    const menu=document.createElement('div');menu.className='tag-menu';const artist=who(item);
    const add=(label,fn)=>menu.append(chip(label,'tag-menu-item',()=>{menu.remove();fn();}));
    if(artist)add(`#${tag} by ${artist}`,()=>navigateTo({type:'artist',artist},artist,{refine:{tags:[tag],not:[]}}));
    add(`#${tag} everywhere`,()=>navigateTo({type:'tag',tag},tag));
    if(!['home','tag'].includes(state.filter.type)||state.filter.type==='tag'&&state.filter.tag.toLocaleLowerCase()!==tag.toLocaleLowerCase())add(`Add #${tag} to this view`,()=>closeAllOverlays(()=>addRefine(tag)));
    add(`Hide #${tag} here`,()=>closeAllOverlays(()=>addRefine(tag,true)));
    const host=anchor.closest('dialog')||document.body;host.append(menu);
    const r=anchor.getBoundingClientRect(),h=host.getBoundingClientRect();
    menu.style.left=`${Math.max(8,Math.min(r.left-h.left,h.width-menu.offsetWidth-8))}px`;menu.style.top=`${r.bottom-h.top+host.scrollTop+4}px`;
    setTimeout(()=>document.addEventListener('click',function off(e){if(!menu.contains(e.target)){menu.remove();document.removeEventListener('click',off,true);}},true),0);
  }

  // ---- Home screen ---------------------------------------------------------
  function renderArtistCards(grid){
    const query=ak(state.homeArtistQuery),stats=new Map();
    for(const item of state.all){const name=who(item)||'Unassigned';let s=stats.get(name);if(!s)stats.set(name,s={count:0,newest:0});s.count++;s.newest=Math.max(s.newest,item.modified||0);}
    let entries=[...stats].filter(([name])=>!query||ak(name).includes(query));
    const sort=state.homeArtistSort;
    entries.sort((a,b)=>a[0]==='Unassigned'?1:b[0]==='Unassigned'?-1:sort==='count'?b[1].count-a[1].count:sort==='newest'?b[1].newest-a[1].newest:collator.compare(a[0],b[0]));
    grid.replaceChildren();
    for(const [name,s] of entries){const card=document.createElement('button');card.type='button';card.className='browse-folder-card';card.addEventListener('click',()=>{state.expanded.add(name);setFilter({type:'artist',artist:name==='Unassigned'?'':name},name);});const icon=document.createElement('span');icon.className='browse-folder-icon';const key=avatarKey(name),image=document.createElement('img'),symbol=document.createElement('span');image.className='browse-folder-avatar';image.alt='';image.hidden=true;image.dataset.artistAvatar=key;symbol.className='browse-folder-symbol';symbol.textContent='♙';symbol.dataset.avatarFallback=key;icon.append(image,symbol);const title=document.createElement('span');title.className='browse-folder-name';title.textContent=name;const total=document.createElement('span');total.className='browse-folder-count';total.textContent=`${s.count.toLocaleString()} ${s.count===1?'item':'items'}`;card.append(icon,title,total);grid.append(card);observeArtistAvatar(card,name);}
    if(!entries.length){const none=document.createElement('p');none.className='artist-empty';none.textContent=query?'No artist matches.':'Add artist names in an item’s details to group them here.';grid.append(none);}
  }

  function startServiceWorker(){if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./service-worker.js').catch(()=>{});}
  function init(){
    openDB().then(async db=>{
      state.db=db;const legacy=await request('settings','get','legacyCatalog');const avatars=await request('settings','get','artistAvatars');const welcome=await request('settings','get','welcomeSeen');state.legacy=legacy?.value||[];indexLegacy();state.artistAvatars=avatars?.value||{};
      try{for(const record of await request('thumbs','getAll'))state.thumbs.set(record.id,record);}catch{}
      loadSavedView();await pcLoadSaved();await refreshData();startServiceWorker();await pcInit();navInit();
      if(!welcome&&state.all.length===0){$('#library-dialog').showModal();await request('settings','put',{key:'welcomeSeen',value:true});}
    }).catch(e=>{showToast(`MediaLib could not open local browser storage: ${e.message}`,8000);});
    $('#import-button').addEventListener('click',()=>$('#files-input').click());
    $('#import-folder').addEventListener('click',importFolder);
    $('#directory-input').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
    $('#files-input').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
    $('#empty-import').addEventListener('click',()=>$('#files-input').click());
    $('#new-folder').addEventListener('click',()=>openFolderDialog());
    $('#new-folder-side').addEventListener('click',()=>$('#new-folder').click());
    $('#folder-form').addEventListener('submit',async e=>{if(e.submitter?.id==='create-folder'||!e.submitter){e.preventDefault();const name=$('#folder-name').value;await saveCollection(name);if(name.trim())$('#folder-dialog').close();}});
    $$('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{if(btn.dataset.filter==='home'){setFilter({type:'home'},'Browse library');}else if(btn.dataset.filter==='all-media'){setKind('all');setFilter({type:'all'},'All media');}else{setKind('image');setFilter({type:'all'},'Images');}}));
    $$('.filter-chip').forEach(btn=>btn.addEventListener('click',()=>setKind(btn.dataset.kind)));
    $('#sort-select').addEventListener('change',e=>{state.sort=e.target.value;if(state.sort==='random')state.shuffleSeed=String(Date.now());try{localStorage.setItem('medialib-sort',state.sort);}catch{}applyFilter();});
    let searchTimer=0;$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=$('#search').value.trim();applyFilter();replaceView();},160);});
    $('#tag-search').addEventListener('input',()=>renderSidebar());
    $('#more-tags').addEventListener('click',()=>{state.showAllTags=!state.showAllTags;renderSidebar();});
    $('#load-more').addEventListener('click',()=>renderPage(false));
    if('IntersectionObserver'in window)new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&!$('#load-more').hidden)renderPage(false);},{root:$('#gallery-wrap'),rootMargin:'800px'}).observe($('#load-more'));
    document.addEventListener('keydown',e=>{if($('#lightbox').open){if(e.key==='ArrowRight'){e.preventDefault();lbStep(1);}else if(e.key==='ArrowLeft'){e.preventDefault();lbStep(-1);}else if(e.key==='+'||e.key==='='){lbZoomAt(0,0,lb.scale*1.25,true);}else if(e.key==='-'){lbZoomAt(0,0,lb.scale/1.25,true);}return;}if(!$('#detail-dialog').open||(e.target instanceof Element&&e.target.closest('input,textarea')))return;if(e.key==='ArrowRight'){e.preventDefault();stepDetail(1);}else if(e.key==='ArrowLeft'){e.preventDefault();stepDetail(-1);}});
    $('#add-to-collection').addEventListener('click',addSelectionToCollection);
    $('#clear-selection').addEventListener('click',()=>{state.selected.clear();updateSelection();});
    $('#import-catalog').addEventListener('click',()=>$('#legacy-input').click());
    $('#export-catalog').addEventListener('click',exportCatalog);
    $('#choose-legacy').addEventListener('click',e=>{e.preventDefault();$('#library-dialog').close();$('#legacy-input').click();});
    $('#legacy-input').addEventListener('change',e=>{if(e.target.files[0])importLegacy(e.target.files[0]);e.target.value='';});
    $('#library-tools').addEventListener('click',()=>$('#manage-dialog').showModal());
    $('#close-manage').addEventListener('click',()=>$('#manage-dialog').close());
    $('#export-library').addEventListener('click',()=>{$('#manage-dialog').close();exportFullLibrary();});
    $('#import-library').addEventListener('click',()=>{$('#manage-dialog').close();$('#library-archive-input').click();});
    $('#library-archive-input').addEventListener('change',e=>{if(e.target.files[0])importFullLibrary(e.target.files[0]);e.target.value='';});
    $('#delete-library').addEventListener('click',deleteLibrary);
    $('#pc-connect').addEventListener('click',openPcDialog);
    $('#pc-refresh').addEventListener('click',()=>pcRefresh(false));
    $('#pc-disconnect').addEventListener('click',()=>{$('#manage-dialog').close();pcDisconnect();});
    $('#pc-form').addEventListener('submit',async e=>{if(e.submitter?.value==='cancel')return;e.preventDefault();const key=$('#pc-key').value.trim()||state.pc.link?.key||'';if(await pcSaveLink($('#pc-url').value,key))$('#pc-dialog').close();});
    $('#mobile-nav-toggle').addEventListener('click',()=>{const sidebar=$('.sidebar'),open=!sidebar.classList.contains('open');sidebar.classList.toggle('open',open);$('#mobile-nav-toggle').setAttribute('aria-expanded',String(open));});
    $('#gallery-wrap').addEventListener('click',e=>{if(e.target===e.currentTarget&&matchMedia('(max-width:560px)').matches){$('.sidebar').classList.remove('open');$('#mobile-nav-toggle').setAttribute('aria-expanded','false');}});
    document.addEventListener('click',e=>{if(matchMedia('(max-width:560px)').matches&&$('.sidebar').classList.contains('open')&&!e.target.closest('.sidebar')&&!e.target.closest('#mobile-nav-toggle')){$('.sidebar').classList.remove('open');$('#mobile-nav-toggle').setAttribute('aria-expanded','false');}});
    $('#tags-button').addEventListener('click',()=>openTagSheet());
    $('#density-button').addEventListener('click',cycleDensity);
    $$('#tag-scope button').forEach(b=>b.addEventListener('click',()=>{state.sheetScope=b.dataset.scope;renderTagSheet();}));
    let sheetTimer=0;$('#tag-sheet-search').addEventListener('input',()=>{clearTimeout(sheetTimer);sheetTimer=setTimeout(renderTagSheet,120);});
    $('#tag-sheet-close').addEventListener('click',()=>$('#tag-sheet').close());
    $('#tag-sheet').addEventListener('close',()=>closedOverlay('tags',state.sheetDirty?pushView:null));
    for(const id of ['#tag-sheet','#detail-dialog'])$(id).addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.close();});
    $('#artist-search').addEventListener('input',()=>renderSidebar());
    $('#select-all').addEventListener('click',()=>{for(const item of state.visible)state.selected.add(item.id);updateSelection();});
    const scroller=$('#gallery-wrap'),toTop=$('#to-top');let topTick=0;
    scroller.addEventListener('scroll',()=>{if(topTick)return;topTick=requestAnimationFrame(()=>{topTick=0;toTop.hidden=scroller.scrollTop<1200;});},{passive:true});
    toTop.addEventListener('click',()=>scroller.scrollTo({top:0,behavior:'smooth'}));
    lbSetupGestures();
  }
  init();
})();
