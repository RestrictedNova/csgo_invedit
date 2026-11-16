import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command, encodeCreate, encodeModify } from '../protocol.js';
import { InventoryConnection } from '../connection.js';

const u32 = (...values) => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return view.buffer;
};
const concat = (...buffers) => {
  const out = new Uint8Array(buffers.reduce((n, b) => n + b.byteLength, 0));
  let offset = 0;
  for (const b of buffers) { out.set(new Uint8Array(b), offset); offset += b.byteLength; }
  return out.buffer;
};

const rifle = {
  highId: 42, inventory: 5, defIndex: 7, level: 1, quality: 4, flags: 0, origin: 8, inUse: 0, rarity: 5,
  attributes: [{ defIndex: 8, value: '0.150000' }], equips: [],
};

// A connected InventoryConnection with a fake socket and manual timers.
function connected() {
  const sockets = [], timers = [];
  class FakeSocket {
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(buffer) { this.sent.push(buffer); }
    close() { this.readyState = 3; }
  }
  const connection = new InventoryConnection(() => {}, {
    WebSocketClass: FakeSocket,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
  });
  connection.connect();
  const socket = sockets[0];
  const receive = buffer => socket.onmessage({ data: buffer });
  receive(u32(Command.protocolInfo, 1));
  receive(concat(u32(Command.snapshot), encodeCreate(rifle, rifle.highId)));
  return { connection, socket, timers, receive };
}

test('a save is confirmed by the GC echoing the item back', () => {
  const { connection, socket, receive } = connected();
  assert.equal(connection.status, 'Connected');
  const updated = { ...structuredClone(rifle), attributes: [...rifle.attributes, { defIndex: 111, value: 'Hi' }] };
  connection.modify(updated, 'Rifle');
  assert.equal(connection.modification.status, 'pending');
  assert.equal(connection.canMutate, false, 'other changes wait for the save');
  assert.equal(socket.sent.length, 1);
  receive(encodeModify(updated));
  assert.equal(connection.modification.status, 'confirmed');
  assert.equal(connection.inventory.items.get(42).attributes.at(-1).value, 'Hi');
  assert.equal(connection.canMutate, true);
});

test('an echo for another item does not confirm the save', () => {
  const { connection, receive } = connected();
  receive(encodeCreate({ ...rifle }, 99));
  connection.modify(rifle, 'Rifle');
  receive(encodeModify({ ...rifle, highId: 99 }));
  assert.equal(connection.modification.status, 'pending');
});

test('an unanswered save becomes uncertain after the timeout', () => {
  const { connection, timers } = connected();
  connection.modify(rifle, 'Rifle');
  timers.find(timer => timer.ms === 10000 && !timer.cleared).fn();
  assert.equal(connection.modification.status, 'uncertain');
});

test('disconnecting mid-save reports it as unconfirmed', () => {
  const { connection } = connected();
  connection.modify(rifle, 'Rifle');
  connection.disconnect();
  assert.equal(connection.modification.status, 'unconfirmed');
  assert.equal(connection.pendingModify, null);
});

test('saving refuses unknown items and overlapping requests', () => {
  const { connection } = connected();
  assert.throws(() => connection.modify({ ...rifle, highId: 7 }, 'x'), /existing item/);
  connection.delete(42, 'Rifle');
  assert.throws(() => connection.modify(rifle, 'Rifle'), /no pending request/);
});
