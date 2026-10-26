(() => {
  'use strict';
  const DB_NAME = 'medialib-local-library';
  const DB_VERSION = 1;
  const PAGE_SIZE = 72;
  const IMAGE_EXT = new Set(['jpg','jpeg','png','gif','webp','bmp','tif','tiff','heic','heif','avif']);
  const VIDEO_EXT = new Set(['mp4','mov','m4v','webm','avi','mkv','3gp']);
  const AUDIO_EXT = new Set(['mp3','m4a','aac','wav','flac','ogg','opus']);
  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
  const state = { db:null, all:[], collections:[], visible:[], filter:{type:'all'}, kind:'image', sort:'newest', query:'', selected:new Set(), expanded:new Set(), showAllTags:false, page:0, legacy:[], objectUrls:new Map(), toastTimer:0, importBusy:false, editingCollectionId:null };

  function openDB() {
    return new Promise((resolve,reject) => {
      const req = indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded = () => {
        const db=req.result;
        const media=db.createObjectStore('media',{keyPath:'id'});
        media.createIndex('relativePath','relativePath',{unique:true});
        db.createObjectStore('collections',{keyPath:'id'});
        db.createObjectStore('settings',{keyPath:'key'});
      };
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
  function legacyMatch(relativePath,name){
    const matches=state.legacy.filter(x=>String(x.name).toLocaleLowerCase()===name.toLocaleLowerCase());
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
    if(first.toLocaleLowerCase()==='aryion')first=underRoot[1]||'';
    else if(first.toLocaleLowerCase()==='.arygrabber-medialib-backup')first=underRoot[1]||'';
    return first;
  }
  function formatDate(value){return value?new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Date unknown';}

  async function refreshData(){
    [state.all,state.collections]=await Promise.all([request('media','getAll'),request('collections','getAll')]);
    state.all.sort((a,b)=>(b.modified||0)-(a.modified||0)||a.name.localeCompare(b.name));
    renderSidebar(); updateStorage(); applyFilter();
  }
  async function updateStorage(){
    if(!navigator.storage?.estimate){$('#storage-note').textContent='';return;}
    try{const {usage=0,quota=0}=await navigator.storage.estimate();$('#storage-note').textContent=`${prettyBytes(usage)} stored`+(quota?` · ${prettyBytes(quota)} available`:'');}catch{}
  }
  function setFilter(filter,title){
    state.filter=filter; if(filter.type!=='all')state.kind='all';
    $$('.filter-chip').forEach(button=>button.classList.toggle('active',button.dataset.kind===state.kind));
    if(title)$('#page-title').textContent=title;
    renderSidebar(); applyFilter();
    if(matchMedia('(max-width:560px)').matches)$('#sidebar').classList.remove('open');
  }
  function setKind(kind){state.kind=kind;$$('.filter-chip').forEach(b=>b.classList.toggle('active',b.dataset.kind===kind));applyFilter();}
  function isInFilter(item){
    const f=state.filter;
    if(f.type==='artist'&&item.creator!==f.artist)return false;
    if(f.type==='artist-folder'&&(item.creator!==f.artist||item.folder!==f.folder))return false;
    if(f.type==='tag'&&!item.tags.some(t=>t.toLocaleLowerCase()===f.tag.toLocaleLowerCase()))return false;
    if(f.type==='collection'&&!(item.collectionIds||[]).includes(f.id))return false;
    if(state.kind!=='all'&&item.kind!==state.kind)return false;
    if(state.query){const q=state.query.toLocaleLowerCase();const hay=[item.name,item.creator,item.folder,item.notes,...item.tags].join(' ').toLocaleLowerCase();if(!hay.includes(q))return false;}
    return true;
  }
  function applyFilter(){
    state.visible=state.all.filter(isInFilter);state.visible.sort((a,b)=>state.sort==='oldest'?(a.modified||0)-(b.modified||0):(b.modified||0)-(a.modified||0));state.page=0;state.selected.clear();$('#selection-bar').hidden=true;
    $('#result-count').textContent=`${state.visible.length.toLocaleString()} ${state.visible.length===1?'item':'items'}`;
    const active=$('.filter-chip.active');if(active)active.classList.toggle('active',true);
    renderPage(true);
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
    $$('[data-filter]').forEach(btn=>btn.classList.toggle('selected',state.filter.type==='all'&&(btn.dataset.filter==='all'&&state.kind==='image'||btn.dataset.filter==='all-media'&&state.kind==='all')));
    const artists=new Map();
    for(const item of state.all){const who=(item.creator||'').trim()||'Unassigned';if(!artists.has(who))artists.set(who,[]);artists.get(who).push(item);}
    const sortedArtists=[...artists.entries()].sort((a,b)=>a[0]==='Unassigned'?1:b[0]==='Unassigned'?-1:a[0].localeCompare(b[0]));
    if(!sortedArtists.length){const e=document.createElement('div');e.className='artist-empty';e.textContent='Artists appear here when you add creator names to your media.';artistRoot.append(e);}
    for(const [artist,items] of sortedArtists){
      const row=document.createElement('div');row.className='artist-group';
      const isActive=state.filter.type==='artist'&&state.filter.artist===artist;
      const title=navButton(artist,'♙',items.length,isActive,()=>setFilter(artist==='Unassigned'?{type:'artist',artist:''}:{type:'artist',artist},artist));
      title.querySelector('.nav-row span:nth-child(2)')?.classList.add('artist-name');row.append(title);
      const toggle=document.createElement('button');toggle.type='button';toggle.className='artist-expand';toggle.textContent=state.expanded.has(artist)?'▾':'›';toggle.setAttribute('aria-label',`${state.expanded.has(artist)?'Collapse':'Expand'} ${artist} folders`);
      toggle.addEventListener('click',()=>{state.expanded.has(artist)?state.expanded.delete(artist):state.expanded.add(artist);renderSidebar();});row.append(toggle);artistRoot.append(row);
      if(state.expanded.has(artist)){
        const folderSet=new Set(items.map(x=>x.folder).filter(Boolean));const folderNames=[...folderSet].sort((a,b)=>a.localeCompare(b));
        const sub=document.createElement('div');sub.className='artist-folders';
        if(!folderNames.length){const empty=document.createElement('div');empty.className='artist-empty';empty.textContent='No folders';sub.append(empty);}
        for(const folder of folderNames){const label=folder.split(/[\\/]/).filter(Boolean).at(-1)||folder;const active=state.filter.type==='artist-folder'&&state.filter.artist===artist&&state.filter.folder===folder;sub.append(navButton(label,'↳',items.filter(x=>x.folder===folder).length,active,()=>setFilter({type:'artist-folder',artist:artist==='Unassigned'?'':artist,folder},label,'folder-row')));}
        artistRoot.append(sub);
      }
    }
    const counts=new Map();for(const item of state.all)for(const tag of item.tags||[])counts.set(tag,(counts.get(tag)||0)+1);
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
  function revokeUrls(){for(const url of state.objectUrls.values())URL.revokeObjectURL(url);state.objectUrls.clear();}
  function mediaURL(item){if(!state.objectUrls.has(item.id))state.objectUrls.set(item.id,URL.createObjectURL(item.blob));return state.objectUrls.get(item.id);}
  function createPreview(item,detail=false){
    const holder=document.createElement('div');holder.className=detail?'detail-preview':'media-preview';
    if(item.kind==='image'){
      const img=document.createElement('img');img.src=mediaURL(item);img.alt=item.name;img.loading=detail?'eager':'lazy';holder.append(img);
    }else if(item.kind==='video'){
      const video=document.createElement('video');video.src=mediaURL(item);video.preload=detail?'metadata':'none';video.muted=true;video.playsInline=true;if(detail){video.controls=true;}else{video.setAttribute('aria-label',item.name);}holder.append(video);
    }else{const icon=document.createElement('span');icon.className=detail?'detail-audio':'media-placeholder';icon.textContent='♫';holder.append(icon);}
    return holder;
  }
  function renderPage(reset=false){
    if(reset){revokeUrls();$('#gallery').replaceChildren();}
    $('#empty-state').hidden=state.visible.length!==0;
    if(!state.visible.length){$('#load-more').hidden=true;$('#empty-title').textContent=state.all.length?'No matches in this view.':'Your library starts here.';$('#empty-text').textContent=state.all.length?'Try another tag, artist, or search.':'Choose a folder on your computer or photos and files on your phone. Originals stay where they are; MediaLib keeps a private copy on this device.';return;}
    const start=state.page*PAGE_SIZE,end=Math.min(start+PAGE_SIZE,state.visible.length);const frag=document.createDocumentFragment();
    for(let i=start;i<end;i++){
      const item=state.visible[i],card=document.createElement('article');card.className='media-card';card.dataset.id=item.id;card.addEventListener('click',()=>openDetail(item));
      const check=document.createElement('input');check.type='checkbox';check.className='media-check';check.checked=state.selected.has(item.id);check.setAttribute('aria-label',`Select ${item.name}`);check.addEventListener('click',e=>e.stopPropagation());check.addEventListener('change',()=>{check.checked?state.selected.add(item.id):state.selected.delete(item.id);updateSelection();});card.append(check);
      card.append(createPreview(item));
      const title=document.createElement('div');title.className='media-title';title.textContent=item.name;title.title=item.name;card.append(title);
      const tags=document.createElement('div');tags.className='media-tags';for(const value of item.tags||[]){const chip=document.createElement('span');chip.className='media-tag';chip.textContent=value;tags.append(chip);}card.append(tags);
      const creator=document.createElement('div');creator.className='media-creator';creator.textContent=item.creator||'';card.append(creator);
      frag.append(card);
    }
    $('#gallery').append(frag);state.page=Math.ceil(end/PAGE_SIZE);$('#load-more').hidden=end>=state.visible.length;
  }
  function updateSelection(){
    $('#selection-count').textContent=`${state.selected.size} selected`;$('#selection-bar').hidden=state.selected.size===0;
    $$('.media-card').forEach(card=>{const cb=$('.media-check',card);if(cb)cb.checked=state.selected.has(card.dataset.id);});
  }
  async function openDetail(item){
    const dialog=$('#detail-dialog'),root=$('#detail-content');root.replaceChildren();const inner=document.createElement('div');inner.className='detail-inner';
    const preview=createPreview(item,true);const close=document.createElement('button');close.className='detail-close';close.type='button';close.textContent='×';close.setAttribute('aria-label','Close');close.addEventListener('click',()=>dialog.close());preview.append(close);inner.append(preview);
    const form=document.createElement('form');form.className='detail-form';form.addEventListener('submit',e=>e.preventDefault());
    const title=document.createElement('h2');title.textContent=item.name;form.append(title);
    const path=document.createElement('p');path.className='detail-path';path.textContent=[item.creator,item.folder,prettyBytes(item.size),formatDate(item.modified)].filter(Boolean).join('  ·  ');form.append(path);
    const creator=makeField(form,'Artist / creator','text',item.creator||'');
    const tags=makeField(form,'Tags · separate with commas','text',(item.tags||[]).join(', '));
    const notes=makeField(form,'Notes','textarea',item.notes||'');
    const cLabel=document.createElement('label');cLabel.className='field-label';cLabel.textContent='Virtual folders';form.append(cLabel);
    const chipArea=document.createElement('div');chipArea.className='detail-collections';const memberships=new Set(item.collectionIds||[]);
    for(const collection of state.collections){const chip=document.createElement('button');chip.type='button';chip.className=`collection-toggle ${memberships.has(collection.id)?'active':''}`;chip.textContent=collection.name;chip.addEventListener('click',()=>{memberships.has(collection.id)?memberships.delete(collection.id):memberships.add(collection.id);chip.classList.toggle('active',memberships.has(collection.id));});chipArea.append(chip);}
    if(!state.collections.length){const no=document.createElement('span');no.className='artist-empty';no.textContent='Create a virtual folder to collect this item.';chipArea.append(no);}form.append(chipArea);
    const actions=document.createElement('div');actions.className='detail-actions';const open=document.createElement('a');open.className='open-original';open.href=mediaURL(item);open.download=item.name;open.textContent='Save a copy';actions.append(open);
    const save=document.createElement('button');save.type='button';save.className='button primary';save.textContent='Save details';save.addEventListener('click',async()=>{
      item.creator=creator.value.trim();item.tags=[...new Set(tags.value.split(',').map(x=>x.trim()).filter(Boolean))];item.notes=notes.value.trim();item.collectionIds=[...memberships];
      try{await request('media','put',item);dialog.close();await refreshData();showToast('Details saved on this device.');}catch(e){showToast(`Could not save: ${e.message}`);}
    });actions.append(save);form.append(actions);inner.append(form);root.append(inner);dialog.showModal();
    dialog.onclose=()=>{revokeUrls();renderPage(true);};
  }
  function makeField(parent,label,type,value){
    const l=document.createElement('label');l.className='field-label';l.textContent=label;parent.append(l);
    const el=document.createElement(type==='textarea'?'textarea':'input');if(type!=='textarea')el.type=type;el.value=value;parent.append(el);return el;
  }
  async function importFiles(files){
    if(state.importBusy)return;const accepted=[...files].filter(f=>mediaKind(f));if(!accepted.length){showToast('No supported photos, videos, or audio files found.');return;}
    const existing=new Map(state.all.map(x=>[normalizedPath(x.relativePath),x]));state.importBusy=true;const total=accepted.reduce((n,f)=>{const old=existing.get(normalizedPath(f.webkitRelativePath||f.name));return n+Math.max(0,f.size-(old?.size||0));},0);const estimate=await navigator.storage?.estimate?.().catch(()=>null);const room=estimate?.quota?estimate.quota-estimate.usage:Infinity;
    if(total>room*.9){state.importBusy=false;showToast(`This selection is larger than the browser’s estimated free space (${prettyBytes(Math.max(0,room))}). Choose fewer or smaller files.` ,5000);return;}
    await navigator.storage?.persist?.().catch(()=>false);
    const toast=$('#toast');toast.textContent=`Adding ${accepted.length.toLocaleString()} files…`;toast.classList.add('show');
    let done=0,added=0,finalMessage='',finalTimeout=4000;
    try{
      for(const file of accepted){
        const relative=file.webkitRelativePath||file.name;const norm=normalizedPath(relative);const prior=existing.get(norm);const legacy=legacyMatch(relative,file.name);
        const parts=relative.split(/[\\/]/).filter(Boolean);const afterRoot=parts.slice(1);let folder=afterRoot.slice(0,-1).join('/');let creator=defaultCreator(relative);
        if(legacy){if(legacy.folder)folder=legacy.folder;if(legacy.creator)creator=legacy.creator;}
        const item={id:prior?.id||crypto.randomUUID(),relativePath:relative,name:file.name,folder,kind:mediaKind(file),size:file.size,modified:file.lastModified||Date.now(),creator:prior?.creator||creator||'',tags:prior?.tags||legacy?.tags||[],notes:prior?.notes||legacy?.notes||'',collectionIds:prior?.collectionIds||legacy?.collectionIds||[],blob:file};
        if(legacy){if(!item.creator)item.creator=legacy.creator||legacy.artist||'';if(!item.tags.length)item.tags=Array.isArray(legacy.tags)?legacy.tags:String(legacy.tags||'').split(',').map(t=>t.trim()).filter(Boolean);if(!item.notes)item.notes=legacy.notes||'';}
        await request('media','put',item);existing.set(norm,item);done++;added++;
        if(done%8===0||done===accepted.length){toast.textContent=`Adding ${done.toLocaleString()} of ${accepted.length.toLocaleString()} files…`;}
      }
      await refreshData();finalMessage=`Added ${added.toLocaleString()} files to this device.`;
    }catch(error){await refreshData();finalMessage=error?.name==='QuotaExceededError'?'Browser storage is full. The files already added are still in your library.':'Import stopped. Files already added are still in your library.';finalTimeout=6000;}
    finally{state.importBusy=false;toast.classList.remove('show');}
    showToast(finalMessage,finalTimeout);
  }
  async function saveCollection(name){
    name=name.trim();if(!name)return;
    if(state.collections.some(c=>c.name.toLocaleLowerCase()===name.toLocaleLowerCase()&&c.id!==state.editingCollectionId)){showToast('A virtual folder with that name already exists.');return;}
    const previous=state.collections.find(c=>c.id===state.editingCollectionId);
    await request('collections','put',{id:state.editingCollectionId||crypto.randomUUID(),name,created:previous?.created||Date.now()});await refreshData();showToast(previous?`Renamed folder to “${name}”.`:`Created “${name}”.`);state.editingCollectionId=null;
  }
  function openFolderDialog(collection=null){
    state.editingCollectionId=collection?.id||null;$('#folder-name').value=collection?.name||'';$('#folder-dialog h2').textContent=collection?'Rename virtual folder':'New virtual folder';$('#folder-dialog p').textContent=collection?'Change this folder’s name. The collected media stays in place.':'Collect items here without moving your original files.';$('#create-folder').textContent=collection?'Save name':'Create folder';$('#folder-dialog').showModal();$('#folder-name').focus();
  }
  async function deleteCollection(collection){
    if(!confirm(`Delete the virtual folder “${collection.name}”? Your media files will stay in the library.`))return;
    await request('collections','delete',collection.id);if(state.filter.type==='collection'&&state.filter.id===collection.id)state.filter={type:'all'};await refreshData();showToast('Virtual folder deleted. The media was not changed.');
  }
  async function addSelectionToCollection(){
    const id=$('#collection-select').value;if(!id){showToast('Choose a virtual folder first.');return;}
    const updates=[];for(const itemId of state.selected){const item=await request('media','get',itemId);if(!item)continue;item.collectionIds=[...new Set([...(item.collectionIds||[]),id])];updates.push(item);}
    await writeMany('media',updates);state.selected.clear();await refreshData();showToast(`Added ${updates.length} items to the virtual folder.`);
  }
  async function importLegacy(file){
    try{
      const json=JSON.parse(await file.text());if(!json||!Array.isArray(json.items))throw new Error('That file is not a MediaLib catalog export.');
      if(Array.isArray(json.collections))for(const collection of json.collections){if(collection.id&&collection.name)await request('collections','put',collection);}
      state.legacy=json.items;await request('settings','put',{key:'legacyCatalog',value:state.legacy});let count=0;const current=state.all;
      for(const item of current){const match=legacyMatch(item.relativePath,item.name);if(!match)continue;let changed=false;
        const creator=String(match.creator||match.artist||'').trim();if(creator&&item.creator!==creator){item.creator=creator;changed=true;}
        const newTags=Array.isArray(match.tags)?match.tags:String(match.tags||'').split(',').map(t=>t.trim()).filter(Boolean);if(!item.tags?.length&&newTags.length){item.tags=newTags;changed=true;}
        if(newTags.length&&JSON.stringify(item.tags)!==JSON.stringify(newTags)){item.tags=newTags;changed=true;}
        if(match.notes&&item.notes!==match.notes){item.notes=match.notes;changed=true;}
        if(match.folder&&item.folder!==match.folder){item.folder=match.folder;changed=true;}
        if((match.collectionIds||[]).length){const merged=[...new Set([...(item.collectionIds||[]),...match.collectionIds])];if(merged.length!==(item.collectionIds||[]).length){item.collectionIds=merged;changed=true;}}
        if(changed){await request('media','put',item);count++;}
      }
      await refreshData();
      showToast(count?`Restored details for ${count} matching files.`:`Catalog loaded. Add the matching media folder to connect its details.`,6000);
    }catch(e){showToast(e.message||'Could not read that catalog export.',5000);}
  }
  function exportCatalog(){
    const payload={schema:'medialib-catalog-v1',exportedAt:new Date().toISOString(),collections:state.collections,items:state.all.map(item=>({path:item.relativePath,name:item.name,folder:item.folder,kind:item.kind,size:item.size,modified:item.modified,creator:item.creator,tags:item.tags,notes:item.notes,collectionIds:item.collectionIds||[]}))};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='MediaLib-catalog.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);showToast('Catalog metadata exported. Media files are not included.');
  }
  async function exportFullLibrary(){
    const media=state.all;if(!media.length){showToast('There are no media files in this library to export.');return;}
    if(media.length+1>65535||media.some(item=>item.blob.size>=0xffffffff)){showToast('This library is too large for the current archive format.',5000);return;}
    const toast=$('#toast');toast.textContent=`Preparing full-library archive · 0 of ${media.length} files`;toast.classList.add('show');
    const files=media.map((item,index)=>({item,name:`media/${String(index+1).padStart(6,'0')}-${encodeURIComponent(item.name)}`}));
    const catalog={schema:'medialib-full-library-v1',exportedAt:new Date().toISOString(),collections:state.collections,items:files.map(({item,name})=>({id:item.id,path:item.relativePath,relativePath:item.relativePath,name:item.name,folder:item.folder,kind:item.kind,size:item.size,modified:item.modified,creator:item.creator,tags:item.tags||[],notes:item.notes||'',collectionIds:item.collectionIds||[],bundlePath:name}))};
    const metadataBlob=new Blob([JSON.stringify(catalog)],{type:'application/json'});const entries=[{name:'MediaLib-library.json',blob:metadataBlob},...files.map(x=>({name:x.name,blob:x.item.blob}))];
    let finalMessage='',finalTimeout=6000;
    try{
      const archive=await MediaLibArchive.createArchive(entries,(done,total,bytes)=>{if(done%8===1||done===total)toast.textContent=`Preparing full-library archive · ${done.toLocaleString()} of ${total.toLocaleString()} files · ${prettyBytes(bytes)}`;});
      const url=URL.createObjectURL(archive),a=document.createElement('a');a.href=url;a.download=`MediaLib-library-${new Date().toISOString().slice(0,10)}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);finalMessage=`Exported ${media.length} media files and catalog. Keep the archive private.`;
    }catch(error){finalMessage=`Library export stopped: ${error.message}`;finalTimeout=7000;}
    finally{toast.classList.remove('show');}
    showToast(finalMessage,finalTimeout);
  }
  function clearStore(name){return new Promise((resolve,reject)=>{const tx=state.db.transaction(name,'readwrite');tx.objectStore(name).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Library clear failed'));});}
  async function clearLibraryData(){await Promise.all(['media','collections','settings'].map(clearStore));state.legacy=[];state.filter={type:'all'};state.kind='image';state.query='';$('#search').value='';$('#page-title').textContent='Images';}
  async function importFullLibrary(file){
    const toast=$('#toast');toast.textContent='Reading library archive…';toast.classList.add('show');let finalMessage='',finalTimeout=6000;
    try{
      const {catalog,entries}=await MediaLibArchive.parseArchive(file,(done,total)=>{$('#toast').textContent=`Checking library archive · ${done} of ${total} files`;});const total=catalog.items.reduce((n,x)=>n+(x.size||0),0);const estimate=await navigator.storage?.estimate?.().catch(()=>null);
      if(estimate?.quota&&total>estimate.quota)throw new Error(`Archive is ${prettyBytes(total)}; browser storage estimate is ${prettyBytes(estimate.quota)}.`);
      if(!confirm(`Replace this device’s current MediaLib with ${catalog.items.length.toLocaleString()} items (${prettyBytes(total)}) from this archive? The current browser copy and virtual folders will be replaced; original files elsewhere are unchanged.`))return;
      await clearLibraryData();
      for(const collection of catalog.collections||[])await request('collections','put',collection);
      for(let i=0;i<catalog.items.length;i++){
        const item=catalog.items[i],entry=entries.get(item.bundlePath),blob=entry.blob;
        await request('media','put',{id:item.id||crypto.randomUUID(),relativePath:item.relativePath||item.path||item.name,name:item.name,folder:item.folder||'',kind:item.kind||'image',size:item.size||blob.size,modified:item.modified||Date.now(),creator:item.creator||item.artist||'',tags:Array.isArray(item.tags)?item.tags:String(item.tags||'').split(',').map(x=>x.trim()).filter(Boolean),notes:item.notes||'',collectionIds:item.collectionIds||[],blob});
        if(i%8===0||i===catalog.items.length-1)toast.textContent=`Importing library · ${i+1} of ${catalog.items.length} files`;
      }
      await request('settings','put',{key:'welcomeSeen',value:true});await refreshData();finalMessage=`Imported ${catalog.items.length.toLocaleString()} media files and virtual folders.`;
    }catch(error){finalMessage=`Library import stopped: ${error.message}`;finalTimeout=7000;try{await refreshData();}catch{}}
    finally{toast.classList.remove('show');}
    showToast(finalMessage,finalTimeout);
  }
  async function deleteLibrary(){
    if(!state.all.length&&!state.collections.length){showToast('This library is already empty.');return;}
    if(!confirm(`Delete this MediaLib library from this device? This removes ${state.all.length.toLocaleString()} local media copies, tags, notes, and virtual folders. Original files outside MediaLib are not deleted.`))return;
    await clearLibraryData();await request('settings','put',{key:'welcomeSeen',value:true});await refreshData();$('#manage-dialog').close();showToast('This device now has a new, empty library.');
  }
  function startServiceWorker(){if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./service-worker.js').catch(()=>{});}
  function init(){
    openDB().then(async db=>{
      state.db=db;const legacy=await request('settings','get','legacyCatalog');const welcome=await request('settings','get','welcomeSeen');state.legacy=legacy?.value||[];
      await refreshData();startServiceWorker();
      if(!welcome&&state.all.length===0){$('#library-dialog').showModal();await request('settings','put',{key:'welcomeSeen',value:true});}
    }).catch(e=>{showToast(`MediaLib could not open local browser storage: ${e.message}`,8000);});
    $('#import-button').addEventListener('click',()=>{const menu=$('#import-menu');menu.hidden=true;$('#import-options').setAttribute('aria-expanded','false');$('#files-input').click();});
    $('#import-options').addEventListener('click',()=>{const menu=$('#import-menu');menu.hidden=!menu.hidden;$('#import-options').setAttribute('aria-expanded',String(!menu.hidden));});
    $('#import-menu').addEventListener('click',e=>{const action=e.target.closest('[data-import]')?.dataset.import;if(!action)return;$('#import-menu').hidden=true;$('#import-options').setAttribute('aria-expanded','false');(action==='folder'?$('#directory-input'):$('#files-input')).click();});
    $('#directory-input').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
    $('#files-input').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
    $('#empty-import').addEventListener('click',()=>$('#files-input').click());
    $('#new-folder').addEventListener('click',()=>openFolderDialog());
    $('#new-folder-side').addEventListener('click',()=>$('#new-folder').click());
    $('#folder-form').addEventListener('submit',async e=>{if(e.submitter?.id==='create-folder'||!e.submitter){e.preventDefault();const name=$('#folder-name').value;await saveCollection(name);if(name.trim())$('#folder-dialog').close();}});
    $$('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{if(btn.dataset.filter==='all-media'){setKind('all');setFilter({type:'all'},'All media');}else{setKind('image');setFilter({type:'all'},'Images');}}));
    $$('.filter-chip').forEach(btn=>btn.addEventListener('click',()=>setKind(btn.dataset.kind)));
    $('#sort-select').addEventListener('change',e=>{state.sort=e.target.value;applyFilter();});
    let searchTimer=0;$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=$('#search').value.trim();applyFilter();},160);});
    $('#tag-search').addEventListener('input',()=>renderSidebar());
    $('#more-tags').addEventListener('click',()=>{state.showAllTags=!state.showAllTags;renderSidebar();});
    $('#load-more').addEventListener('click',()=>renderPage(false));
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
    $('#mobile-nav-toggle').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
    $('#gallery-wrap').addEventListener('click',e=>{if(e.target===e.currentTarget&&matchMedia('(max-width:560px)').matches)$('#sidebar').classList.remove('open');});
    document.addEventListener('click',e=>{if(matchMedia('(max-width:560px)').matches&&$('#sidebar').classList.contains('open')&&!e.target.closest('.sidebar')&&!e.target.closest('#mobile-nav-toggle'))$('#sidebar').classList.remove('open');});
    document.addEventListener('click',e=>{if(!e.target.closest('.import-wrap')){$('#import-menu').hidden=true;$('#import-options').setAttribute('aria-expanded','false');}});
  }
  init();
})();
