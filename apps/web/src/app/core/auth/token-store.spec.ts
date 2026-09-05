// WHY: jsdom ships no IndexedDB at all; this shim installs the globals the
// store needs. Its WebCrypto is Node's real implementation, so AES-GCM and the
// non-extractable CryptoKey are exercised for real, not stubbed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { StoredTokens, TokenStore } from './token-store';

const TOKENS: StoredTokens = {
  idToken: 'id-token-value',
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
};

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('auth', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tokens');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRaw(db: IDBDatabase, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tokens', 'readwrite');
    tx.objectStore('tokens').put(value, 'session');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

describe('TokenStore', () => {
  let store: TokenStore;

  beforeEach(() => {
    // Each test gets a pristine database; fake-indexeddb persists across specs otherwise.
    globalThis.indexedDB = new IDBFactory();
    store = new TokenStore();
  });

  it('round-trips the tokens through write() and read()', async () => {
    await store.write(TOKENS);

    await expect(store.read()).resolves.toEqual(TOKENS);
  });

  it('stores the tokens as ciphertext beside a non-extractable key, never as plaintext', async () => {
    await store.write(TOKENS);

    const db = await openRawDatabase();
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = db.transaction('tokens', 'readonly').objectStore('tokens').get('session');
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });
    db.close();

    const key = record['key'] as CryptoKey;
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();

    const bytes = new Uint8Array(record['ciphertext'] as ArrayBuffer);
    const asText = new TextDecoder().decode(bytes);
    expect(asText).not.toContain(TOKENS.accessToken);
    expect(asText).not.toContain(TOKENS.refreshToken);
  });

  it('uses a fresh IV on every write', async () => {
    await store.write(TOKENS);
    const first = await readIv();
    await store.write(TOKENS);
    const second = await readIv();

    expect(Array.from(second)).not.toEqual(Array.from(first));

    async function readIv(): Promise<Uint8Array> {
      const db = await openRawDatabase();
      const iv = await new Promise<Uint8Array>((resolve, reject) => {
        const request = db.transaction('tokens', 'readonly').objectStore('tokens').get('session');
        request.onsuccess = () => resolve((request.result as { iv: Uint8Array }).iv);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return iv;
    }
  });

  it('leaves nothing readable after clear()', async () => {
    await store.write(TOKENS);
    await store.clear();

    await expect(store.read()).resolves.toBeNull();
  });

  it('returns null rather than throwing when no record exists', async () => {
    await expect(store.read()).resolves.toBeNull();
  });

  it('returns null rather than throwing when the record lost its key', async () => {
    const db = await openRawDatabase();
    await putRaw(db, { iv: new Uint8Array(12), ciphertext: new ArrayBuffer(16) });
    db.close();

    await expect(store.read()).resolves.toBeNull();
  });

  it('returns null rather than throwing when the ciphertext is corrupt', async () => {
    await store.write(TOKENS);

    const db = await openRawDatabase();
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = db.transaction('tokens', 'readonly').objectStore('tokens').get('session');
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });
    // Flip a byte so the AES-GCM authentication tag fails to verify.
    const corrupted = new Uint8Array(record['ciphertext'] as ArrayBuffer);
    corrupted[0] ^= 0xff;
    await putRaw(db, { ...record, ciphertext: corrupted.buffer });
    db.close();

    await expect(store.read()).resolves.toBeNull();
  });

  it('returns null rather than throwing when the plaintext is not a token set', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode('not json at all'),
    );

    const db = await openRawDatabase();
    await putRaw(db, { key, iv, ciphertext });
    db.close();

    await expect(store.read()).resolves.toBeNull();
  });

  it('resolves clear() even when IndexedDB is unavailable', async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;

    await expect(store.clear()).resolves.toBeUndefined();
  });
});
