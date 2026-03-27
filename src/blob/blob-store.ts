export interface BlobStore {
  put(cid: string, data: Buffer, mimeType: string): Promise<void>;
  get(cid: string): Promise<{ data: Buffer; mimeType: string } | null>;
  delete(cid: string): Promise<void>;
  exists(cid: string): Promise<boolean>;
}

export type BlobStoreType = 'local' | 's3';

import { config } from '../config.js';

let _store: BlobStore | null = null;

export async function getBlobStore(): Promise<BlobStore> {
  if (_store) return _store;

  const storeType = config.blob.storage as BlobStoreType;

  if (storeType === 's3') {
    const { S3BlobStore } = await import('./s3-store.js');
    _store = new S3BlobStore();
  } else {
    const { LocalBlobStore } = await import('./local-store.js');
    _store = new LocalBlobStore(config.blob.localPath);
  }

  return _store;
}
