import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, editableFields } from '../item-edit.js';

// Values as the GC sends them: floats with six decimals.
const rifle = {
  highId: 42, inventory: 5, defIndex: 7, level: 1, quality: 4, flags: 0, origin: 8, inUse: 0, rarity: 5,
  attributes: [{ defIndex: 6, value: '282.000000' }, { defIndex: 7, value: '661.000000' }, { defIndex: 8, value: '0.150000' }, { defIndex: 80, value: '12' }],
  equips: [{ classId: 2, slotId: 2 }],
};

// Presentation stand-in with only what editableFields uses.
const presentation = category => ({
  paint: new Map([[282, { wearMin: 0, wearMax: 0.7 }]]),
  item: () => ({ category }),
});

test('editableFields exposes paint, StatTrak and name fields with readable numbers', () => {
  const fields = editableFields(rifle, presentation('weapons'));
  assert.equal(fields.painted, true);
  assert.equal(fields.statTrak, true);
  assert.equal(fields.nameable, true);
  assert.equal(fields.wearMax, 0.7);
  assert.deepEqual(fields.values, { name: '', wear: '0.15', seed: '661', counter: '12' });
});

test('stickers are nameable only when they already have a name', () => {
  const sticker = { ...rifle, attributes: [{ defIndex: 113, value: '5' }] };
  assert.equal(editableFields(sticker, presentation('stickers')).nameable, false);
  const named = { ...sticker, attributes: [...sticker.attributes, { defIndex: 111, value: 'x' }] };
  assert.equal(editableFields(named, presentation('stickers')).nameable, true);
});

test('applyEdits changes only touched fields and keeps the GC formatting elsewhere', () => {
  const result = applyEdits(rifle, { name: '  Old Faithful  ', counter: '500' }, editableFields(rifle, presentation('weapons')));
  assert.deepEqual(result.attributes, [
    { defIndex: 6, value: '282.000000' }, { defIndex: 7, value: '661.000000' }, { defIndex: 8, value: '0.150000' },
    { defIndex: 80, value: '500' }, { defIndex: 111, value: 'Old Faithful' },
  ]);
  assert.deepEqual(result.equips, rifle.equips);
  assert.equal(rifle.attributes.length, 4, 'the input item is not mutated');
});

test('applyEdits removes a name tag when it is cleared', () => {
  const named = { ...rifle, attributes: [...rifle.attributes, { defIndex: 111, value: 'Old' }] };
  const result = applyEdits(named, { name: '   ' }, editableFields(named, presentation('weapons')));
  assert.equal(result.attributes.some(a => a.defIndex === 111), false);
});

test('applyEdits validates ranges', () => {
  const fields = editableFields(rifle, presentation('weapons'));
  assert.throws(() => applyEdits(rifle, { wear: '0.8' }, fields), /between 0 and 0.7/);
  assert.throws(() => applyEdits(rifle, { wear: 'abc' }, fields), /Paint wear/);
  assert.throws(() => applyEdits(rifle, { seed: '1.5' }, fields), /integer/);
  assert.throws(() => applyEdits(rifle, { counter: '-1' }, fields), /StatTrak/);
  assert.equal(applyEdits(rifle, { wear: '0.0001' }, fields).attributes.find(a => a.defIndex === 8).value, '0.0001');
});
