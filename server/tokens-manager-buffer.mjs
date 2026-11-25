import { threadId } from 'node:worker_threads';

const LOCK = 0;
const ACTIVE = 1;
const FIRST_USED = 2;
const HEADER_BYTES = 4 * Int32Array.BYTES_PER_ELEMENT;
const SIZE_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const ROUND_BYTES = 64 * 1024 * 1024;

export function createPacketBuffer(capacity = ROUND_BYTES) {
  return new SharedArrayBuffer(HEADER_BYTES + 2 * capacity);
}

export function openPacketBuffer(buffer) {
  const header = new Int32Array(buffer, 0, 4);
  const data = new Uint8Array(buffer, HEADER_BYTES);
  const lengths = new DataView(buffer, HEADER_BYTES);
  const capacity = data.length / 2;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function acquire() {
    let holder;
    while ((holder = Atomics.compareExchange(header, LOCK, 0, threadId + 1)) !== 0) {
      Atomics.wait(header, LOCK, holder);
    }
  }

  function release(owner = threadId) {
    if (Atomics.compareExchange(header, LOCK, owner + 1, 0) === owner + 1) {
      Atomics.notify(header, LOCK, 1);
    }
  }

  function appendBatch(entries) {
    const encoded = entries.map(entry => encoder.encode(JSON.stringify(entry)));
    const accepted = new Array(encoded.length).fill(false);
    acquire();
    try {
      const active = Atomics.load(header, ACTIVE);
      const start = active * capacity;
      let used = Atomics.load(header, FIRST_USED + active);
      for (let index = 0; index < encoded.length; index++) {
        const bytes = encoded[index];
        const end = used + SIZE_BYTES + bytes.length;
        if (end > capacity) continue;
        const offset = start + used;
        lengths.setUint32(offset, bytes.length, true);
        data.set(bytes, offset + SIZE_BYTES);
        used = end;
        accepted[index] = true;
      }
      Atomics.store(header, FIRST_USED + active, used);
      return accepted;
    } finally {
      release();
    }
  }

  function* read(start, end) {
    for (let offset = start; offset < end;) {
      const size = lengths.getUint32(offset, true);
      offset += SIZE_BYTES;
      yield JSON.parse(decoder.decode(data.subarray(offset, offset + size)));
      offset += size;
    }
  }

  function take() {
    acquire();
    try {
      const active = Atomics.load(header, ACTIVE);
      const next = 1 - active;
      const used = Atomics.load(header, FIRST_USED + active);
      Atomics.store(header, FIRST_USED + next, 0);
      Atomics.store(header, ACTIVE, next);
      const start = active * capacity;
      // The ranking worker consumes this view before switching buffers again.
      return read(start, start + used);
    } finally {
      release();
    }
  }

  return { appendBatch, take, release };
}
