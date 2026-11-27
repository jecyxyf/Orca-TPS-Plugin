import { threadId } from 'node:worker_threads';

const LOCK = 0, ACTIVE = 1, FIRST_USED = 2;
const HEADER_BYTES = 16, SIZE_BYTES = 4, ROUND_BYTES = 32 * 1024 * 1024;

export const createPacketBuffer = (capacity = ROUND_BYTES) => new SharedArrayBuffer(HEADER_BYTES + 2 * capacity);

export function openPacketBuffer(buffer) {
  const header = new Int32Array(buffer, 0, 4), data = new Uint8Array(buffer, HEADER_BYTES);
  const lengths = new DataView(buffer, HEADER_BYTES), capacity = data.length / 2;
  const encoder = new TextEncoder(), decoder = new TextDecoder();

  const acquire = () => {
    for (let holder; (holder = Atomics.compareExchange(header, LOCK, 0, threadId + 1)) !== 0;) Atomics.wait(header, LOCK, holder);
  };
  const release = (owner = threadId) => {
    if (Atomics.compareExchange(header, LOCK, owner + 1, 0) === owner + 1) Atomics.notify(header, LOCK, 1);
  };

  function appendBatch(entries) {
    const encoded = entries.map(entry => encoder.encode(JSON.stringify(entry))), accepted = new Array(encoded.length).fill(false);
    acquire();
    try {
      const active = Atomics.load(header, ACTIVE), start = active * capacity;
      let used = Atomics.load(header, FIRST_USED + active);
      for (let i = 0; i < encoded.length; i++) {
        const bytes = encoded[i], end = used + SIZE_BYTES + bytes.length;
        if (end > capacity) continue;
        lengths.setUint32(start + used, bytes.length, true);
        data.set(bytes, start + used + SIZE_BYTES);
        used = end;
        accepted[i] = true;
      }
      Atomics.store(header, FIRST_USED + active, used);
      return accepted;
    } finally { release(); }
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
      const active = Atomics.load(header, ACTIVE), next = 1 - active, used = Atomics.load(header, FIRST_USED + active);
      Atomics.store(header, FIRST_USED + next, 0);
      Atomics.store(header, ACTIVE, next);
      return read(active * capacity, active * capacity + used);
    } finally { release(); }
  }

  return { appendBatch, take, release };
}
