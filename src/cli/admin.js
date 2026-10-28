import net from 'node:net';
import { chmod, mkdir, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function startAdmin(path, dispatch) {
  if(process.platform!=='win32'){
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const old=await lstat(path).catch(()=>null);
    if(old){if(!old.isSocket())throw new Error('Admin socket path is occupied by a non-socket');
      const alive=await new Promise(resolve=>{const socket=net.connect(path);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});
      if(alive)throw new Error('An LLMesh daemon already uses the admin socket');await unlink(path);}
  }
  const server=net.createServer(socket=>{
    socket.setTimeout(10000,()=>socket.destroy());let input='';
    socket.on('data',data=>{input+=data;if(input.length>65536)return socket.destroy();if(!input.includes('\n'))return;
      socket.pause();void(async()=>{try{const message=JSON.parse(input.split('\n')[0]);const result=await dispatch(message);socket.end(JSON.stringify({ok:true,result})+'\n');}catch(error){socket.end(JSON.stringify({ok:false,error:error.message})+'\n');}})();});
    socket.on('error',()=>{});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
  if(process.platform!=='win32')await chmod(path,0o660);
  return server;
}
export async function adminRequest(path,message){return new Promise((resolve,reject)=>{
  const socket=net.connect(path);let data='';socket.setTimeout(30000,()=>socket.destroy(new Error('Admin request timed out')));
  socket.once('connect',()=>socket.write(JSON.stringify(message)+'\n'));socket.on('data',chunk=>{data+=chunk;if(data.length>1024*1024)socket.destroy(new Error('Admin response too large'));});
  socket.once('end',()=>{try{const response=JSON.parse(data);if(!response.ok)reject(new Error(response.error));else resolve(response.result);}catch(error){reject(error);}});socket.once('error',reject);
});}
