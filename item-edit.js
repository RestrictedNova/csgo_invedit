// Editing an item the GC already owns. The GC replaces the whole item with what
// we send, so edits are applied to its latest copy right before saving.
export const Attribute = Object.freeze({ paintIndex: 6, paintSeed: 7, paintWear: 8, statTrakCounter: 80, customName: 111 });

// Name tags apply to these in game. Other items keep an existing name editable so it can be removed.
const NAMEABLE = new Set(['weapons', 'knives']);

// The GC prints floats with fixed decimals ("0.150000"); show the shortest equivalent.
function displayNumber(value) {
  if (value === undefined || String(value).trim() === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value);
}

export function editableFields(item, presentation) {
  const attrs = new Map(item.attributes.map(a => [a.defIndex, a.value]));
  const paint = presentation.paint.get(Number(attrs.get(Attribute.paintIndex)));
  return {
    painted: attrs.has(Attribute.paintSeed) && attrs.has(Attribute.paintWear),
    wearMin: paint?.wearMin ?? 0,
    wearMax: paint?.wearMax ?? 1,
    statTrak: attrs.has(Attribute.statTrakCounter),
    nameable: NAMEABLE.has(presentation.item(item).category) || attrs.has(Attribute.customName),
    values: {
      name: attrs.get(Attribute.customName) ?? '',
      wear: displayNumber(attrs.get(Attribute.paintWear)),
      seed: displayNumber(attrs.get(Attribute.paintSeed)),
      counter: displayNumber(attrs.get(Attribute.statTrakCounter)),
    },
  };
}

function numeric(text, label, min, max, integer = false) {
  const value = Number(text);
  if (String(text).trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

// Only fields present in edits change; everything else keeps the GC's value and formatting.
export function applyEdits(item, edits, fields) {
  const result = structuredClone(item);
  const set = (defIndex, value) => {
    const attribute = result.attributes.find(a => a.defIndex === defIndex);
    if (attribute) attribute.value = value;
    else result.attributes.push({ defIndex, value });
  };
  if ('name' in edits) {
    if (!fields.nameable) throw new Error('This item cannot have a name tag.');
    const name = edits.name.trim();
    if (name) set(Attribute.customName, name);
    else result.attributes = result.attributes.filter(a => a.defIndex !== Attribute.customName);
  }
  if ('wear' in edits) {
    if (!fields.painted) throw new Error('This item has no paint wear.');
    set(Attribute.paintWear, String(numeric(edits.wear, 'Paint wear', fields.wearMin, fields.wearMax)));
  }
  if ('seed' in edits) {
    if (!fields.painted) throw new Error('This item has no paint seed.');
    set(Attribute.paintSeed, String(numeric(edits.seed, 'Paint seed', 0, 1000, true)));
  }
  if ('counter' in edits) {
    if (!fields.statTrak) throw new Error('This item has no StatTrak counter.');
    set(Attribute.statTrakCounter, String(numeric(edits.counter, 'StatTrak counter', 0, 0xffffffff, true)));
  }
  return result;
}
