const {app,nativeImage}=require('electron');
const fs=require('node:fs');const path=require('node:path');
app.whenReady().then(()=>{
const root=path.resolve('assets/branding'), source=nativeImage.createFromPath(path.join(root,'logo.png'));
if(source.isEmpty())throw new Error('Logo could not be loaded');
const sizes=[16,24,32,48,64,128,256];const pngs=sizes.map(size=>source.resize({width:size,height:size,quality:'best'}).toPNG());
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
for(let i=0;i<sizes.length;i++){const p=6+i*16;header[p]=sizes[i]===256?0:sizes[i];header[p+1]=header[p];header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(pngs[i].length,p+8);header.writeUInt32LE(offset,p+12);offset+=pngs[i].length;}
fs.writeFileSync(path.join(root,'icon.ico'),Buffer.concat([header,...pngs]));
fs.writeFileSync(path.join(root,'icon.png'),source.resize({width:512,height:512,quality:'best'}).toPNG());
console.log('Generated logo icon sizes: '+sizes.join(', '));app.quit();
});
