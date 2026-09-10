import { Injectable } from '@angular/core';

/** The Users service's AuthTokens contract, as this app persists it. */
export interface StoredTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

const DB_NAME = 'auth';
const DB_VERSION = 1;
const STORE_NAME = 'tokens';
const RECORD_KEY = 'session';

/** AES-GCM's standard 96-bit nonce — the size every implementation is tuned for. */
const IV_BYTES = 12;

interface EncryptedRecord {
  key: CryptoKey;
  /**
   * CONTRACT: Keep the `<ArrayBuffer>` argument. A bare `Uint8Array` widens to
   * `ArrayBufferLike`, which WebCrypto's `BufferSource` rejects because it
   * admits `SharedArrayBuffer` — the failure is a type error at every
   * encrypt/decrypt call, not at this declaration.
   */
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

/**
 * CONTRACT: Identify the binary fields by tag, NOT with `instanceof`. A value
 * cloned out of IndexedDB may carry another realm's constructor, making
 * `x instanceof ArrayBuffer` false for a genuine ArrayBuffer — read() would
 * then discard every record it just wrote and log the user out on reload.
 * Measured: swapping this for `instanceof` turns the round-trip test red under
 * jsdom, while the same swap passes in plain Node — the realm split is the
 * environment's, so a green run elsewhere does not clear it.
 * See [[2026-09-04-instanceof-across-a-structured-clone-realm]]
 */
function isBinary(value: unknown, tag: 'ArrayBuffer' | 'Uint8Array'): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value)?.constructor?.name === tag
  );
}

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<EncryptedRecord>;
  return (
    typeof record.key === 'object' &&
    record.key !== null &&
    'algorithm' in record.key &&
    isBinary(record.iv, 'Uint8Array') &&
    isBinary(record.ciphertext, 'ArrayBuffer')
  );
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== 'object' || value === null) return false;
  const tokens = value as Partial<StoredTokens>;
  return (
    typeof tokens.idToken === 'string' &&
    typeof tokens.accessToken === 'string' &&
    typeof tokens.refreshToken === 'string'
  );
}

/** Bridges an IDBRequest to a promise; every DB access in this file goes through it. */
function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
}

/** Auth tokens as AES-GCM ciphertext in IndexedDB, beside a non-extractable key. */

/**
 * WARNING: Encrypting blocks exfiltration of tokens IN THE CLEAR — storage
 * scraping, a devtools dump, a profile backup. It does NOT stop an active XSS
 * calling `decrypt()` in the page, and no SPA can: any key the page uses,
 * injected code uses too. Do NOT read this as XSS protection.
 */

/**
 * CONTRACT: `read()`, `write()` and `clear()` are the whole surface. Callers
 * must never reach IndexedDB or WebCrypto directly — a second writer overwrites
 * the record's key and strands the session it was holding.
 */
@Injectable({ providedIn: 'root' })
export class TokenStore {
  /**
   * CONTRACT: Returns null on a missing, unreadable or corrupt record — it must
   * never throw. A user whose key was wiped lands on /login; a rejection here
   * instead bricks the app during boot, before any route can render.
   */
  async read(): Promise<StoredTokens | null> {
    try {
      const db = await openDatabase();
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const record: unknown = await awaitRequest(tx.objectStore(STORE_NAME).get(RECORD_KEY));
        if (!isEncryptedRecord(record)) return null;

        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: record.iv },
          record.key,
          record.ciphertext,
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
        return isStoredTokens(parsed) ? parsed : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  /** Replaces the stored session. Rejects if persistence fails, so a caller can surface it. */
  async write(tokens: StoredTokens): Promise<void> {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    /**
     * CONTRACT: Generate a fresh IV for every write. Reusing an IV under the
     * same AES-GCM key leaks the XOR of both plaintexts and forfeits the
     * authentication guarantee entirely.
     */
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(tokens)),
    );

    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: EncryptedRecord = { key, iv, ciphertext };
      await awaitRequest(tx.objectStore(STORE_NAME).put(record, RECORD_KEY));
    } finally {
      db.close();
    }
  }

  /** Drops the record, key object included, so nothing remains decryptable. */
  async clear(): Promise<void> {
    try {
      const db = await openDatabase();
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        await awaitRequest(tx.objectStore(STORE_NAME).delete(RECORD_KEY));
      } finally {
        db.close();
      }
    } catch {
      // WHY: Sign-out must complete even where IndexedDB is unavailable
      // (private mode, blocked storage); there is nothing left to clear there.
    }
  }
}
