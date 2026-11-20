import type { Scene } from './types';

// ---- IndexedDB key/value (autosave) ----
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('stratos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result as T | undefined);
    r.onerror = () => rej(r.error);
  });
}

export async function idbSet(key: string, val: unknown) {
  const d = await db();
  return new Promise<void>((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---- Share links: deflate-raw + base64url in the URL hash, no server ----
async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeScene(scene: Scene): Promise<string> {
  const z = await pipe(new TextEncoder().encode(JSON.stringify(scene)), new CompressionStream('deflate-raw'));
  let s = '';
  for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode(...z.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodeScene(code: string): Promise<Scene> {
  const b = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  const raw = await pipe(bytes, new DecompressionStream('deflate-raw'));
  return validateScene(JSON.parse(new TextDecoder().decode(raw)));
}

export function validateScene(s: any): Scene {
  if (!s || typeof s !== 'object' || !s.nodes || !s.edges || !Array.isArray(s.layers) || !s.layers.length) {
    throw new Error('Not a Stratos scene');
  }
  s.stops ??= [];
  s.v = 1;
  return s as Scene;
}

export function download(name: string, data: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
