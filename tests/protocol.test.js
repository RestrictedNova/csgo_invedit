import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command, decodeMessage, encodeCreate, encodeModify } from '../protocol.js';

const u32 = (...values) => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return [...new Uint8Array(view.buffer)];
};
const bytes = text => [...new TextEncoder().encode(text)];

const rifle = {
  highId: 42, inventory: 5, defIndex: 7, level: 1, quality: 4, flags: 0, origin: 8, inUse: 0, rarity: 5,
  attributes: [{ defIndex: 8, value: '0.15' }, { defIndex: 111, value: 'Ünï ✓' }],
  equips: [{ classId: 2, slotId: 3 }],
};

// Layout read by ParseItem in csgo_gc/inventory_editor.cpp.
const expectedItemBytes = highId => [
  ...u32(highId, 5, 7, 1, 4, 0, 8, 0, 5),
  ...u32(2), ...u32(8, 4), ...bytes('0.15'), ...u32(111, bytes('Ünï ✓').length), ...bytes('Ünï ✓'),
  ...u32(1), ...u32(2, 3),
];

test('encodeCreate puts the request ID in the item ID slot', () => {
  const template = { ...rifle };
  delete template.highId;
  assert.deepEqual([...new Uint8Array(encodeCreate(template, 7))], [...u32(Command.create), ...expectedItemBytes(7)]);
});

test('encodeModify sends the real item ID and round-trips through decodeMessage', () => {
  const buffer = encodeModify(rifle);
  assert.deepEqual([...new Uint8Array(buffer)], [...u32(Command.modify), ...expectedItemBytes(42)]);
  const [command] = decodeMessage(buffer);
  assert.equal(command.type, Command.modify);
  assert.deepEqual(command.item, rifle);
});

test('encoders reject invalid items', () => {
  assert.throws(() => encodeModify({ ...rifle, highId: -1 }), /highId/);
  assert.throws(() => encodeModify(null), /Invalid item/);
  assert.throws(() => encodeCreate({ ...rifle, inUse: 2 }, 1), /inUse/);
});

test('decodeMessage rejects counts larger than the remaining data', () => {
  const buffer = new Uint8Array([...u32(Command.create), ...u32(1, 0, 0, 0, 0, 0, 0, 0, 0), ...u32(0xffffffff)]).buffer;
  assert.throws(() => decodeMessage(buffer), /count/);
});
