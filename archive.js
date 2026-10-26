((root) => {
  'use strict';
  const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}return table;})();
  async function crc32(blob){
    let crc=0xffffffff;
    if(blob.stream){const reader=blob.stream().getReader();while(true){const {done,value}=await reader.read();if(done)break;for(const byte of value)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);}}
    else{for(let offset=0;offset<blob.size;offset+=1024*1024){const bytes=new Uint8Array(await blob.slice(offset,offset+1024*1024).arrayBuffer());for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);}}
    return (crc^0xffffffff)>>>0;
  }
  function localHeader(name,crc,size){
    const encoded=new TextEncoder().encode(name),bytes=new Uint8Array(30+encoded.length),v=new DataView(bytes.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint16(8,0,true);v.setUint16(10,0,true);v.setUint16(12,33,true);v.setUint32(14,crc,true);v.setUint32(18,size,true);v.setUint32(22,size,true);v.setUint16(26,encoded.length,true);v.setUint16(28,0,true);bytes.set(encoded,30);return {bytes,nameBytes:encoded};
  }
  function centralHeader(name,crc,size,offset){
    const encoded=new TextEncoder().encode(name),bytes=new Uint8Array(46+encoded.length),v=new DataView(bytes.buffer);
    v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x0800,true);v.setUint16(10,0,true);v.setUint16(12,0,true);v.setUint16(14,33,true);v.setUint32(16,crc,true);v.setUint32(20,size,true);v.setUint32(24,size,true);v.setUint16(28,encoded.length,true);v.setUint16(30,0,true);v.setUint16(32,0,true);v.setUint16(34,0,true);v.setUint16(36,0,true);v.setUint32(38,0,true);v.setUint32(42,offset,true);bytes.set(encoded,46);return bytes;
  }
  async function createArchive(entries,onProgress=()=>{}){
    if(entries.length>65535)throw new Error('This library contains too many files for the archive format.');
    const parts=[],directory=[];let offset=0,total=0;
    for(let i=0;i<entries.length;i++){
      const entry=entries[i];if(entry.blob.size>=0xffffffff)throw new Error('One file is larger than the supported archive size.');
      const crc=await crc32(entry.blob),header=localHeader(entry.name,crc,entry.blob.size);
      parts.push(header.bytes,entry.blob);directory.push(centralHeader(entry.name,crc,entry.blob.size,offset));
      offset+=header.bytes.length+entry.blob.size;total+=entry.blob.size;
      if(offset>=0xffffffff)throw new Error('This library exceeds the supported 4 GB archive size.');
      onProgress(i+1,entries.length,total);
    }
    const directoryStart=offset;for(const header of directory){parts.push(header);offset+=header.length;}
    const end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(4,0,true);view.setUint16(6,0,true);view.setUint16(8,entries.length,true);view.setUint16(10,entries.length,true);view.setUint32(12,offset-directoryStart,true);view.setUint32(16,directoryStart,true);view.setUint16(20,0,true);parts.push(end);
    return new Blob(parts,{type:'application/zip'});
  }
  async function parseArchive(file,onProgress=()=>{}){
    const entries=new Map();let offset=0;
    while(offset+30<=file.size){
      const head=await file.slice(offset,offset+30).arrayBuffer(),v=new DataView(head);if(v.getUint32(0,true)!==0x04034b50)break;
      const flags=v.getUint16(6,true),method=v.getUint16(8,true),size=v.getUint32(22,true),nameLength=v.getUint16(26,true),extraLength=v.getUint16(28,true);
      if((flags&0x0008)!==0||method!==0)throw new Error('This archive uses compression or ZIP64. Import a MediaLib library export.');
      const crc=v.getUint32(14,true),nameBytes=await file.slice(offset+30,offset+30+nameLength).arrayBuffer(),name=new TextDecoder().decode(nameBytes),dataStart=offset+30+nameLength+extraLength,dataEnd=dataStart+size;
      if(dataEnd>file.size)throw new Error('The library archive is incomplete.');entries.set(name,{blob:file.slice(dataStart,dataEnd),crc});offset=dataEnd;
    }
    const metadata=entries.get('MediaLib-library.json');if(!metadata)throw new Error('MediaLib catalog was not found in this archive.');
    if(await crc32(metadata.blob)!==metadata.crc)throw new Error('The library catalog failed its integrity check.');
    const catalog=JSON.parse(await metadata.blob.text());if(catalog.schema!=='medialib-full-library-v1'||!Array.isArray(catalog.items))throw new Error('Unsupported MediaLib archive format.');
    for(let i=0;i<catalog.items.length;i++){
      const item=catalog.items[i],entry=entries.get(item.bundlePath);
      if(!item.bundlePath||!entry)throw new Error(`Archive is missing ${item.name||'a media file'}.`);
      if(await crc32(entry.blob)!==entry.crc)throw new Error(`Media file failed its integrity check: ${item.name}`);
      if(i%12===0)onProgress(i+1,catalog.items.length);
    }
    return {catalog,entries};
  }
  const api=Object.freeze({crc32,createArchive,parseArchive});
  root.MediaLibArchive=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
