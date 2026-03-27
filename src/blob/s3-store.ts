import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';
import type { BlobStore } from './blob-store.js';

export class S3BlobStore implements BlobStore {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = config.blob.s3Bucket;
    this.client = new S3Client({
      region: config.blob.s3Region,
      ...(config.blob.s3Endpoint ? { endpoint: config.blob.s3Endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: config.blob.s3AccessKeyId,
        secretAccessKey: config.blob.s3SecretAccessKey,
      },
    });
  }

  private keyFor(cid: string): string {
    const prefix = cid.slice(0, 8);
    return `blobs/${prefix}/${cid}`;
  }

  async put(cid: string, data: Buffer, mimeType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(cid),
      Body: data,
      ContentType: mimeType,
    }));
  }

  async get(cid: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(cid),
      }));
      const body = await response.Body?.transformToByteArray();
      if (!body) return null;
      return {
        data: Buffer.from(body),
        mimeType: response.ContentType || 'application/octet-stream',
      };
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(cid: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(cid),
    }));
  }

  async exists(cid: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(cid),
      }));
      return true;
    } catch {
      return false;
    }
  }
}
