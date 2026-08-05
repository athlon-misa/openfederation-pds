import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { writeCarStream } from '../../src/api/com.atproto.sync.getRepo.js';

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly writes: Uint8Array[] = [];

  write(chunk: Uint8Array): boolean {
    this.writes.push(chunk);
    return this.writes.length > 1;
  }

  end(): void {
    this.writableEnded = true;
  }
}

describe('CAR response streaming', () => {
  it('waits for drain before consuming the next CAR chunk', async () => {
    const req = new EventEmitter();
    const res = new FakeResponse();
    let yielded = 0;
    async function* chunks(): AsyncIterable<Uint8Array> {
      yielded++;
      yield new Uint8Array([1]);
      yielded++;
      yield new Uint8Array([2]);
    }

    const write = writeCarStream(req as never, res as never, chunks());
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.writes).toEqual([new Uint8Array([1])]);
    expect(yielded).toBe(1);

    res.emit('drain');
    await write;
    expect(res.writes).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(res.writableEnded).toBe(true);
  });

  it('stops reading CAR chunks when the client disconnects while backpressured', async () => {
    const req = new EventEmitter();
    const res = new FakeResponse();
    let yielded = 0;
    async function* chunks(): AsyncIterable<Uint8Array> {
      yielded++;
      yield new Uint8Array([1]);
      yielded++;
      yield new Uint8Array([2]);
    }

    const write = writeCarStream(req as never, res as never, chunks());
    await new Promise((resolve) => setImmediate(resolve));
    res.emit('close');
    await write;

    expect(yielded).toBe(1);
    expect(res.writes).toEqual([new Uint8Array([1])]);
    expect(res.writableEnded).toBe(false);
  });
});
