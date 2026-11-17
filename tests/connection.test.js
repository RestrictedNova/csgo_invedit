import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command, decodeMessage, encodeCreate, encodeModify } from '../protocol.js';
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

const crate = { highId: 0, inventory: 1, defIndex: 4029, level: 1, quality: 4, flags: 0, origin: 8, inUse: 0, rarity: 1, attributes: [], equips: [] };

test('a single create is confirmed with its item id', () => {
  const { connection, receive } = connected();
  connection.create(crate, 'Case');
  assert.equal(connection.creation.message, 'Creating Case (request 1)…');
  receive(u32(Command.setId, 1, 200));
  receive(encodeCreate(crate, 200));
  assert.equal(connection.creation.status, 'confirmed');
  assert.equal(connection.creation.highId, 200);
  assert.equal(connection.creation.message, 'Created Case: item 200.');
});

test('a batch of creates goes in one message and is confirmed once every item arrives', () => {
  const { connection, socket, receive } = connected();
  connection.createMany([crate, crate, crate], 'containers');
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(decodeMessage(socket.sent[0]).map(c => [c.type, c.item.highId]), [[Command.create, 1], [Command.create, 2], [Command.create, 3]]);
  assert.equal(connection.canCreate, false, 'other changes wait for the batch');
  // the GC answers every create with its own setId message, then sends the items together
  receive(u32(Command.setId, 1, 100));
  receive(u32(Command.setId, 2, 101));
  receive(u32(Command.setId, 3, 102));
  receive(concat(encodeCreate(crate, 100), encodeCreate(crate, 101)));
  assert.equal(connection.creation.status, 'pending', 'one item is still missing');
  receive(encodeCreate(crate, 102));
  assert.equal(connection.creation.status, 'confirmed');
  assert.equal(connection.creation.count, 3);
  assert.deepEqual(connection.creation.highIds, [100, 101, 102]);
  assert.equal(connection.creation.highId, undefined);
  assert.equal(connection.creation.message, 'Created 3 containers.');
  assert.equal(connection.canCreate, true);
  connection.create(crate, 'Case');
  assert.equal(connection.creation.requestId, 4, 'request IDs continue after the batch');
});

test('setId answers for other requests do not confirm a batch', () => {
  const { connection, receive } = connected();
  connection.createMany([crate, crate], 'containers');
  receive(u32(Command.setId, 1, 100));
  receive(u32(Command.setId, 9, 101));
  receive(concat(encodeCreate(crate, 100), encodeCreate(crate, 101)));
  assert.equal(connection.creation.status, 'pending');
});

test('disconnecting mid-batch reports it as unconfirmed', () => {
  const { connection } = connected();
  connection.createMany([crate, crate, crate], 'containers');
  connection.disconnect();
  assert.equal(connection.creation.status, 'unconfirmed');
  assert.match(connection.creation.message, /^Disconnected before confirming 3 containers\. The items may already exist/);
  assert.equal(connection.pendingCreate, null);
});

test('an empty batch is refused', () => {
  const { connection, socket } = connected();
  assert.throws(() => connection.createMany([], 'containers'), /Select something/);
  assert.equal(socket.sent.length, 0);
});
