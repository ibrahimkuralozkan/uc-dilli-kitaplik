(function () {
  'use strict';
  const databaseNames = ['three_language_reader_data_v44', 'three_language_pdf_library_v29', 'risale_words_db_v11'];
  const legacyKey = /^(?:threepdf_|three_reader_|risale_|sozler_)/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function requestResult(request) {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  function transactionDone(tx) {
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Yerel kayıt işlemi iptal edildi.')); });
  }
  function openExisting(name) {
    return new Promise((resolve, reject) => {
      let missing = false;
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => { missing = true; req.transaction.abort(); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => missing ? resolve(null) : reject(req.error);
    });
  }
  window.createReaderStorage = function (userId) {
    if (!uuid.test(userId)) throw Error('Geçersiz hesap kimliği.');
    const prefix = `reader-account:${userId}:`;
    const scopedName = name => {
      if (!databaseNames.includes(name)) throw Error('Bilinmeyen yerel kitaplık.');
      return `${name}::account::${userId}`;
    };
    return Object.freeze({
      getItem: key => localStorage.getItem(prefix + key),
      setItem: (key, value) => localStorage.setItem(prefix + key, value),
      removeItem: key => localStorage.removeItem(prefix + key),
      matchesEvent: (event, key) => event.key === prefix + key,
      database: Object.freeze({ open: (name, version) => version === undefined ? indexedDB.open(scopedName(name)) : indexedDB.open(scopedName(name), version) }),
      async importLegacy() {
        if (!navigator.locks) throw Error('Bu tarayıcı güvenli yerel aktarımı desteklemiyor. Mevcut JSON/CSV aktarımını kullanın.');
        return navigator.locks.request('reader-legacy-migration-v1', async () => {
          const ownerKey = 'reader-legacy-owner-v1';
          const owner = localStorage.getItem(ownerKey);
          if (owner && owner !== userId) throw Error('Eski kayıtlar bu tarayıcıda başka bir hesaba atanmış. JSON/CSV ile aktarabilirsiniz.');
          // Reserve the source for this account before asynchronous copying; retry is safe.
          localStorage.setItem(ownerKey, userId);
          let records = 0;
          for (const name of databaseNames) {
            const source = await openExisting(name);
            if (!source) continue;
            try {
              const stores = Array.from(source.objectStoreNames);
              if (!stores.length) continue;
              const read = source.transaction(stores, 'readonly');
              const readDone = transactionDone(read);
              const snapshots = await Promise.all(stores.map(async storeName => {
                const store = read.objectStore(storeName);
                const keyPath = store.keyPath, autoIncrement = store.autoIncrement;
                const keysRequest = requestResult(store.getAllKeys());
                const valuesRequest = requestResult(store.getAll());
                return { storeName, keyPath, autoIncrement, keys: await keysRequest, values: await valuesRequest };
              }));
              await readDone;
              const targetRequest = indexedDB.open(scopedName(name), source.version);
              targetRequest.onupgradeneeded = () => {
                for (const snap of snapshots) if (!targetRequest.result.objectStoreNames.contains(snap.storeName)) {
                  targetRequest.result.createObjectStore(snap.storeName, { keyPath: snap.keyPath, autoIncrement: snap.autoIncrement });
                }
              };
              const target = await requestResult(targetRequest);
              try {
                const write = target.transaction(stores, 'readwrite');
                const writeDone = transactionDone(write);
                // Never overwrite an existing account record, including newer vocabulary.
                for (const snap of snapshots) {
                  const store = write.objectStore(snap.storeName);
                  snap.keys.forEach((key, index) => {
                    const check = store.getKey(key);
                    check.onsuccess = () => {
                      if (check.result === undefined) {
                        if (snap.keyPath === null) store.add(snap.values[index], key);
                        else store.add(snap.values[index]);
                        records++;
                      }
                    };
                  });
                }
                await writeDone;
              } finally { target.close(); }
            } finally { source.close(); }
          }
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (legacyKey.test(key)) keys.push(key); }
          for (const key of keys) if (localStorage.getItem(prefix + key) === null) {
            localStorage.setItem(prefix + key, localStorage.getItem(key)); records++;
          }
          localStorage.setItem(`reader-migration-done:${userId}`, '1');
          return records;
        });
      }
    });
  };
  const scope = document.querySelector('meta[name="reader-account"]')?.content;
  if (scope) {
    window.readerStorage = window.createReaderStorage(scope);
    window.readerDB = window.readerStorage.database;
  }
})();
