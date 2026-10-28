import { safeStorage } from 'electron';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
export class ElectronSafeStorage {
  constructor(directory){this.directory=directory;if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw new Error('OS encrypted storage is required');}
  load(name,create){const path=join(this.directory,name);if(!existsSync(path))writeFileSync(path,safeStorage.encryptString(create()),{mode:0o600});return safeStorage.decryptString(readFileSync(path));}
}
