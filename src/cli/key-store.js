import { join } from 'node:path';
import { loadKey } from '../core/key-store.js';
import { secretEnv } from './config.js';
export class FileKeyStore {
  constructor(directory,env=process.env){this.directory=directory;this.env=env;}
  load(name,create){const variable={identity:'LLMESH_IDENTITY_KEY',wallet:'LLMESH_WALLET_KEY',api:'LLMESH_API_KEY'}[name];
    return (variable&&secretEnv(variable,this.env))??loadKey(join(this.directory,name+'.key'),create,secretEnv('LLMESH_KEY_PASSPHRASE',this.env));}
}
