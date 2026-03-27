import { mkdir, writeFile, readFile, unlink, access } from 'fs/promises';
import { join } from 'path';
import type { BlobStore } from './blob-store.js';

export class LocalBlobStore implements BlobStore {
  constructor(private basePath: string) {}

  private pathFor(cid: string): string {
    const prefix = cid.slice(0, 8);
    return join(this.basePath, prefix, cid);
  }

  private metaPathFor(cid: string): string {
    return this.pathFor(cid) + '.meta';
  }

  async put(cid: string, data: Buffer, mimeType: string): Promise<void> {
    const filePath = this.pathFor(cid);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, data);
    await writeFile(this.metaPathFor(cid), mimeType, 'utf-8');
  }

  async get(cid: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const data = await readFile(this.pathFor(cid));
      const mimeType = await readFile(this.metaPathFor(cid), 'utf-8');
      return { data, mimeType };
    } catch {
      return null;
    }
  }

  async delete(cid: string): Promise<void> {
    try {
      await unlink(this.pathFor(cid));
      await unlink(this.metaPathFor(cid));
    } catch {
      // Ignore if already gone
    }
  }

  async exists(cid: string): Promise<boolean> {
    try {
      await access(this.pathFor(cid));
      return true;
    } catch {
      return false;
    }
  }
}
