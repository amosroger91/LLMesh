export class LocalStore {
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('llmesh-local-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('settings');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return this;
  }
  request(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode), request = fn(tx.objectStore(store));
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  get(key) { return this.request('settings', 'readonly', store => store.get(key)); }
  set(key, value) { return this.request('settings', 'readwrite', store => store.put(value, key)); }
}
