import { InventoryConnection } from './connection.js';
import { loadCatalog } from './catalog.js';
import { loadIcons, createThumbnail, setThumbnail } from './icons.js';
import { Presentation, filterInventory } from './presentation.js';
import { VirtualGrid } from './grid.js';
import { CreationPreferences } from './creation-draft.js';
import { applyEdits, editableFields } from './item-edit.js';

const $ = id => document.getElementById(id);
let catalog = null, icons = null, iconsLoading = false, loading = false;
let selectedKey = null, selectedId = null, activeTab = 'inventory';
let presentation = new Presentation(null);
let inventoryMatches = [], catalogueMatches = [];
let previousItems = new Map(), previousCatalog = null;
let drawerReturn = null;
const narrow = matchMedia('(max-width:999px)');
const preferences = new CreationPreferences();
let draftError = '';
let renderedWearKey = null, wearDirty = false;
// Unsaved edits to the selected inventory item, keyed by field. Only touched fields are sent.
let edits = {}, editsFor = null, savedEdits = null;
const editInputs = { name: 'edit-name', wear: 'edit-wear', seed: 'edit-seed', counter: 'edit-counter' };
// Adding everything the catalogue lists: batches the GC confirms one after another. More than
// BULK_CONFIRM items takes a second click.
const BULK_BATCH = 100, BULK_CONFIRM = 500;
let bulk = null, bulkConfirm = null, bulkMessage = '', catalogueAddable = 0;
function creationDraft() {
  draftError = '';
  if (!catalog || !selectedKey) return null;
  try { return preferences.build(catalog, selectedKey); }
  catch (error) { draftError = error.message; return null; }
}

function selectedTemplate() {
  return creationDraft()?.item ?? null;
}
function renderBadges(container, badges) {
  container.replaceChildren(...badges.map(text => {
    const badge = document.createElement('span');
    badge.textContent = text;
    if (text === 'StatTrak') badge.className = 'badge-stattrak';
    return badge;
  }));
}
function renderMetadata(container, entries) {
  container.replaceChildren(...entries.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label; description.textContent = value;
    return [term, description];
  }));
}
function createCard() {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'item-card';
  const image = createThumbnail();
  const title = document.createElement('span'); title.className = 'card-title';
  const subtitle = document.createElement('span'); subtitle.className = 'card-subtitle';
  const badges = document.createElement('span'); badges.className = 'card-badges';
  button.append(image, title, subtitle, badges);
  return button;
}
function updateCard(node, item, record = null) {
  const info = presentation.item(item, record);
  node.dataset.key = record?.key ?? item.highId;
  node.style.setProperty('--rarity', info.color);
  node.children[1].textContent = info.title;
  node.children[2].textContent = info.subtitle;
  renderBadges(node.children[3], info.badges);
  node.setAttribute('aria-label', [info.name, ...info.badges].join(', '));
  node.title = info.name;
  node.setAttribute('aria-pressed', String(record ? selectedKey === record.key : selectedId === item.highId));
  node.classList.toggle('created-item', !record && connection.creation?.status === 'confirmed' && connection.creation.highId === item.highId);
  setThumbnail(node.firstChild, record ? icons?.recordCandidates(record) : icons?.candidates(item));
}
const inventoryGrid = new VirtualGrid($('items'), {
  key: item => item.highId, create: createCard,
  update: (node, item) => updateCard(node, item),
  select: id => { selectedId = id; inventoryGrid.schedule(); renderSelection(); openDrawer(); },
});
const catalogueGrid = new VirtualGrid($('catalog-results'), {
  key: record => record.key, create: createCard,
  update: (node, record) => updateCard(node, record.template ?? { defIndex: record.defIndex, rarity: record.rarity }, record),
  select: key => { commitWear(); selectedKey = key; catalogueGrid.schedule(); renderSelection(); openDrawer(); },
});
// Delegation keeps the action attached to the current virtualized card identity.
$('catalog-results').addEventListener('dblclick', event => {
  const card = event.target.closest('.item-card');
  if (!card || narrow.matches) return;
  commitWear();
  selectedKey = card.dataset.key;
  renderSelection();
  addSelected();
});

function openDrawer() {
  if (!narrow.matches || $('selection').hidden) return;
  drawerReturn = document.activeElement;
  $('inspector').classList.add('drawer-open');
  document.body.classList.add('drawer-active');
  $('inspector').setAttribute('role', 'dialog');
  $('inspector').setAttribute('aria-modal', 'true');
  document.querySelectorAll('main > :not(.workspace), .workspace > section').forEach(node => node.inert = true);
  $('inspector-close').focus();
}
function closeDrawer(restoreFocus = true) {
  $('inspector').classList.remove('drawer-open');
  document.body.classList.remove('drawer-active');
  $('inspector').removeAttribute('role'); $('inspector').removeAttribute('aria-modal');
  document.querySelectorAll('[inert]').forEach(node => node.inert = false);
  if (restoreFocus && drawerReturn?.isConnected) drawerReturn.focus({ preventScroll: true });
}
$('inspector-close').addEventListener('click', () => closeDrawer());
narrow.addEventListener('change', () => { closeDrawer(false); $('inspector-close').hidden = !narrow.matches; });
$('inspector-close').hidden = !narrow.matches;
$('inspector').addEventListener('keydown', event => {
  if (!$('inspector').classList.contains('drawer-open')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
  if (event.key !== 'Tab') return;
  const controls = [...$('inspector').querySelectorAll('button, input')].filter(node => !node.disabled && node.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function renderSelection() {
  const record = activeTab === 'catalog' ? catalog?.records.get(selectedKey) : null;
  const draft = record ? creationDraft() : null;
  // Keep controls available for correcting invalid inputs.
  let controls = draft;
  if (record?.template && !controls) {
    try { const defaults = new CreationPreferences(); defaults.statTrak = preferences.statTrak; controls = defaults.build(catalog, selectedKey); } catch {}
  }
  const item = activeTab === 'inventory' ? connection.inventory.items.get(selectedId) : draft?.item;
  const hasSelection = Boolean(record || item);
  $('selection').hidden = !hasSelection;
  $('inspector-empty').hidden = hasSelection;
  $('create').hidden = activeTab !== 'catalog';
  $('stattrak-label').hidden = !record?.statTrakTemplate;
  $('creation-controls').hidden = !record?.template;
  $('stattrak').checked = preferences.statTrak;
  $('paint-controls').hidden = !controls?.painted;
  $('counter-label').hidden = !controls?.statTrak;
  $('delete').hidden = activeTab !== 'inventory';
  $('delete').disabled = !item || !connection.canMutate;
  $('deletion-status').textContent = connection.deletion?.message || '';
  renderEditor();
  if (controls?.painted) {
    for (const id of ['wear', 'wear-slider']) { $(id).min = controls.min; $(id).max = controls.max; }
    const wear = preferences.wear === null ? controls.min : preferences.commitWear(preferences.wear, controls.min, controls.max);
    if (renderedWearKey !== record.key || (!wearDirty && document.activeElement !== $('wear'))) $('wear').value = wear;
    if (renderedWearKey !== record.key) wearDirty = false;
    $('wear-slider').value = wear;
  }
  renderedWearKey = controls?.painted ? record.key : null;
  $('creation-status').textContent = bulkMessage || connection.creation?.message || '';
  renderBulk();
  $('view-created').hidden = !(connection.creation?.status === 'confirmed' && connection.inventory.items.has(connection.creation.highId));
  if (!hasSelection) { closeDrawer(false); return; }
  const info = presentation.item(item ?? { defIndex: record.defIndex }, record);
  $('selection-name').textContent = info.name;
  renderBadges($('selection-badges'), info.badges);
  const details = [];
  if (!record) {
    details.push(['Item', item.highId]);
    for (const [id, label] of [[8, 'Paint wear'], [7, 'Paint seed']]) {
      const attribute = item.attributes.find(a => a.defIndex === id);
      if (attribute) details.push([label, attribute.value]);
    }
  }
  if (record?.resultDefIndex != null) details.push(['Coupon creates', `Definition ${record.resultDefIndex}`]);
  if (record?.forcedStatTrak) details.push(['StatTrak', 'Forced coupon default']);
  renderMetadata($('selection-info'), details);
  $('selection-reason').textContent = [...new Set([record?.unavailableReason, record ? draftError : ''].filter(Boolean))].join(' ');
  setThumbnail($('selection-icon'), record ? (item ? icons?.candidates(item) : icons?.recordCandidates(record)) : icons?.candidates(item));
  $('create').disabled = !record || !item || !connection.canCreate;
}
function editTarget() {
  const item = activeTab === 'inventory' ? connection.inventory.items.get(selectedId) : null;
  return item ? { item, fields: editableFields(item, presentation) } : null;
}
function renderEditor() {
  if (editsFor !== selectedId) { edits = {}; savedEdits = null; editsFor = selectedId; }
  if (savedEdits === edits && connection.modification?.status === 'confirmed' && connection.modification.highId === selectedId) {
    edits = {}; savedEdits = null;
  }
  $('modification-status').textContent = connection.modification?.message || '';
  const target = editTarget();
  const fields = target?.fields;
  $('edit-controls').hidden = !fields || !(fields.nameable || fields.painted || fields.statTrak);
  if (!fields) return;
  $('edit-name-label').hidden = !fields.nameable;
  $('edit-paint').hidden = !fields.painted;
  $('edit-counter-label').hidden = !fields.statTrak;
  // Rewriting an unchanged value would move the caret while typing.
  for (const [field, id] of Object.entries(editInputs)) {
    const value = edits[field] ?? fields.values[field];
    if ($(id).value !== value) $(id).value = value;
  }
  $('edit-wear-slider').min = fields.wearMin;
  $('edit-wear-slider').max = fields.wearMax;
  const wear = Number(edits.wear ?? fields.values.wear);
  if (Number.isFinite(wear)) $('edit-wear-slider').value = wear;
  let error = '';
  try { applyEdits(target.item, edits, fields); }
  catch (e) { error = e.message; }
  $('edit-error').textContent = error;
  const dirty = Object.keys(edits).length > 0;
  $('edit-controls').disabled = Boolean(connection.pendingModify);
  $('edit-save').disabled = !dirty || Boolean(error) || !connection.canMutate;
  $('edit-revert').disabled = !dirty;
}
function setEdit(field, value) {
  const original = editTarget()?.fields.values[field];
  const next = { ...edits };
  if (value === original) delete next[field];
  else next[field] = value;
  edits = next;
  renderSelection();
}
function saveEdits() {
  const target = editTarget();
  if (!target || !connection.canMutate || !Object.keys(edits).length) return;
  try {
    const updated = applyEdits(target.item, edits, target.fields);
    savedEdits = edits;
    connection.modify(updated, presentation.item(updated).name);
  } catch (error) { $('edit-error').textContent = error.message; }
}
for (const [field, id] of Object.entries(editInputs)) {
  $(id).addEventListener('input', () => setEdit(field, $(id).value));
  $(id).addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); saveEdits(); }
  });
}
$('edit-wear-slider').addEventListener('input', () => setEdit('wear', $('edit-wear-slider').value));
$('edit-save').addEventListener('click', saveEdits);
$('edit-revert').addEventListener('click', () => { edits = {}; renderSelection(); });
function renderCatalog(reset = false) {
  if (!catalog) return;
  const view = $('catalog-view').value;
  $('catalog-all').disabled = view !== 'definitions';
  $('advanced-label').hidden = view !== 'definitions';
  catalogueMatches = catalog.search({ view, category: $('catalog-category').value, query: $('catalog-search').value, allDefinitions: $('catalog-all').checked });
  catalogueAddable = catalogueMatches.filter(record => record.template).length;
  bulkConfirm = null;
  $('catalog-count').textContent = `${catalogueMatches.length.toLocaleString()} items`;
  catalogueGrid.setRecords(catalogueMatches, reset);
  renderSelection();
}
function rebuildInventory(reset = false) {
  inventoryMatches = filterInventory(connection.inventory.items.values(), presentation, { query: $('inventory-search').value, category: $('inventory-category').value });
  $('inventory-count').textContent = `${inventoryMatches.length.toLocaleString()} of ${connection.inventory.items.size.toLocaleString()} items`;
  $('empty').hidden = inventoryMatches.length > 0;
  $('empty').textContent = !connection.inventory.ready ? 'Connect to receive inventory.' : connection.inventory.items.size ? 'No items match your filters.' : 'Inventory is empty.';
  inventoryGrid.setRecords(inventoryMatches, reset);
}
function renderInventory(current) {
  continueBulk();
  $('status').textContent = current.status; $('message').textContent = current.message;
  $('connect').disabled = current.socket !== null; $('disconnect').disabled = current.socket === null;
  $('count').textContent = `(${current.inventory.items.size} items)`;
  if (!current.inventory.items.has(selectedId)) selectedId = null;
  const changed = previousCatalog !== catalog || previousItems.size !== current.inventory.items.size || [...current.inventory.items].some(([id, item]) => previousItems.get(id) !== item);
  if (changed) {
    previousItems = new Map(current.inventory.items); previousCatalog = catalog;
    rebuildInventory();
  } else { inventoryGrid.schedule(); }
  // Connection readiness and empty messages can change without changing the map.
  if (!inventoryMatches.length) {
    $('empty').hidden = false;
    $('empty').textContent = !current.inventory.ready ? 'Connect to receive inventory.' : current.inventory.items.size ? 'No items match your filters.' : 'Inventory is empty.';
  }
  renderSelection();
}
function switchTab(tab) {
  commitWear();
  closeDrawer(false); activeTab = tab;
  for (const name of ['inventory', 'catalog']) {
    $(name + '-panel').hidden = name !== tab;
    $(name + '-tab').setAttribute('aria-selected', String(name === tab));
    $(name + '-tab').tabIndex = name === tab ? 0 : -1;
  }
  inventoryGrid.schedule(); catalogueGrid.schedule(); renderSelection();
}
for (const tab of ['inventory', 'catalog']) {
  $(tab + '-tab').addEventListener('click', () => switchTab(tab));
  $(tab + '-tab').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'inventory' : event.key === 'End' ? 'catalog' : tab === 'inventory' ? 'catalog' : 'inventory';
    switchTab(next); $(next + '-tab').focus();
  });
}
const connection = new InventoryConnection(renderInventory);
$('connect').addEventListener('click', () => connection.connect());
$('disconnect').addEventListener('click', () => connection.disconnect());
window.addEventListener('pagehide', () => connection.disconnect());
for (const id of ['catalog-view', 'catalog-category', 'catalog-all', 'catalog-search']) $(id).addEventListener(id === 'catalog-search' ? 'input' : 'change', () => renderCatalog(true));
for (const id of ['inventory-search', 'inventory-category']) $(id).addEventListener(id === 'inventory-search' ? 'input' : 'change', () => { rebuildInventory(true); renderSelection(); });
$('stattrak').addEventListener('change', () => { preferences.statTrak = $('stattrak').checked; renderSelection(); });
for (const [id, field] of [['wear-slider', 'wear'], ['seed', 'seed'], ['counter', 'counter']]) {
  $(id).addEventListener('input', () => {
    preferences[field] = $(id).value;
    if (id === 'wear-slider') { $('wear').value = $(id).value; wearDirty = false; }
    renderSelection();
  });
}
function commitWear() {
  if (activeTab !== 'catalog' || $('paint-controls').hidden || !wearDirty) return;
  preferences.commitWear($('wear').value, Number($('wear').min), Number($('wear').max));
  $('wear').value = preferences.wear;
  wearDirty = false;
  renderSelection();
}
$('wear').addEventListener('input', () => { wearDirty = true; });
$('wear').addEventListener('blur', commitWear);
$('wear').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); commitWear(); }
});
function addSelected() {
  if (!connection.canCreate || bulk) return;
  commitWear();
  bulkMessage = '';
  try { const record = catalog.records.get(selectedKey); connection.create(selectedTemplate(), record.name || record.internalName || record.key); }
  catch (error) { $('creation-status').textContent = error.message; }
}
$('create').addEventListener('click', addSelected);

function renderBulk() {
  const button = $('catalog-add-all');
  button.disabled = Boolean(bulk) || !catalogueAddable || !connection.canCreate;
  button.textContent = bulk ? 'Adding…'
    : bulkConfirm ? `Click again to add ${bulkConfirm.toLocaleString()} items`
    : `Add all ${catalogueAddable.toLocaleString()} to inventory`;
  const cancel = $('catalog-add-all-cancel');
  cancel.hidden = !bulk && !bulkConfirm;
  cancel.textContent = bulk ? (bulk.stop ? 'Stopping…' : 'Stop') : 'Cancel';
  cancel.disabled = Boolean(bulk?.stop);
}
// Default creation settings for every item, whatever the inspector is set to.
function addAllListed() {
  if (bulk || !catalog || !connection.canCreate) return;
  const defaults = new CreationPreferences();
  const items = [];
  let skipped = 0;
  for (const record of catalogueMatches) {
    try { items.push(defaults.build(catalog, record.key).item); }
    catch { skipped++; }
  }
  if (!items.length) return;
  if (items.length > BULK_CONFIRM && bulkConfirm !== items.length) {
    bulkConfirm = items.length;
    renderBulk();
    return;
  }
  bulkConfirm = null;
  bulk = { items, skipped, sent: 0, added: 0, requestId: null, sending: false, stop: false };
  continueBulk();
  renderSelection();
}
function finishBulk(message) {
  const skipped = bulk.skipped ? ` ${bulk.skipped.toLocaleString()} listed items can't be created and were skipped.` : '';
  bulk = null;
  bulkMessage = message + skipped;
}
// Runs on every connection change: sends the next batch once the last one is confirmed.
function continueBulk() {
  if (!bulk || bulk.sending) return;
  const total = bulk.items.length.toLocaleString();
  if (bulk.requestId !== null) {
    const creation = connection.creation;
    if (creation?.requestId === bulk.requestId && creation.status === 'pending') return;
    if (creation?.requestId !== bulk.requestId || creation.status !== 'confirmed') {
      finishBulk(`Stopped after adding ${bulk.added.toLocaleString()} of ${total} items. ${creation?.message ?? ''}`.trim());
      return;
    }
    bulk.added += creation.count;
    bulk.requestId = null;
  }
  if (bulk.sent === bulk.items.length) { finishBulk(`Added ${total} items to the inventory.`); return; }
  if (bulk.stop) { finishBulk(`Stopped after adding ${bulk.added.toLocaleString()} of ${total} items.`); return; }
  if (!connection.canCreate) {
    if (!connection.socket) finishBulk(`Stopped after adding ${bulk.added.toLocaleString()} of ${total} items: disconnected.`);
    return;
  }
  const batch = bulk.items.slice(bulk.sent, bulk.sent + BULK_BATCH);
  bulk.sent += batch.length;
  bulkMessage = `Adding ${total} items to the inventory: ${bulk.added.toLocaleString()} done…`;
  // createMany reports back synchronously; that must not start another batch
  bulk.sending = true;
  try { connection.createMany(batch, 'items'); }
  catch (error) { bulk.sending = false; finishBulk(`Stopped after adding ${bulk.added.toLocaleString()} of ${total} items. ${error.message}`); return; }
  bulk.sending = false;
  bulk.requestId = connection.creation.requestId;
  if (connection.creation.status !== 'pending') continueBulk();
}
$('catalog-add-all').addEventListener('click', addAllListed);
$('catalog-add-all-cancel').addEventListener('click', () => {
  if (bulk) bulk.stop = true;
  bulkConfirm = null;
  renderBulk();
});
$('delete').addEventListener('click', () => {
  const item = connection.inventory.items.get(selectedId);
  if (!item || !connection.canMutate) return;
  try { connection.delete(item.highId, presentation.item(item).name); }
  catch (error) { $('deletion-status').textContent = error.message; }
});
$('view-created').addEventListener('click', () => {
  const id = connection.creation?.highId;
  if (!connection.inventory.items.has(id)) return;
  if (!inventoryMatches.some(item => item.highId === id)) {
    $('inventory-search').value = ''; $('inventory-category').value = ''; rebuildInventory(true);
  }
  selectedId = id; switchTab('inventory');
  requestAnimationFrame(() => { inventoryGrid.reveal(id, true); renderSelection(); openDrawer(); });
});

async function initializeCatalog() {
  if (loading) return;
  loading = true;
  $('catalog-status').textContent = 'Loading catalogue...';
  $('catalog-status').classList.remove('status-error');
  $('catalog-retry').hidden = true;
  try {
    catalog = await loadCatalog();
    presentation = new Presentation(catalog);
    if (icons) {
      try { icons.assertCatalog(catalog); }
      catch (error) { icons = null; iconFailure(error); }
    }
    $('catalog-status').textContent = '';
    const categories = [...new Set([...catalog.data.definitions, ...catalog.data.variants].map(r => r.category))].sort();
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      $('catalog-category').append(option);
      $('inventory-category').append(option.cloneNode(true));
    }
    $('catalog-controls').disabled = false;
    renderCatalog();
    inventoryGrid.schedule();
    renderInventory(connection);
  } catch (error) {
    $('catalog-status').textContent = `Catalogue unavailable: ${error.message}`;
    $('catalog-status').classList.add('status-error');
    $('catalog-retry').hidden = false;
  } finally { loading = false; }
}
$('catalog-retry').addEventListener('click', initializeCatalog);
function iconFailure(error) {
  $('icon-status').textContent = `Icons unavailable: ${error.message}`;
  $('icon-status').classList.add('status-error');
  $('icon-retry').hidden = false;
}

async function initializeIcons() {
  if (iconsLoading) return;
  iconsLoading = true;
  $('icon-status').textContent = 'Loading icons...';
  $('icon-status').classList.remove('status-error');
  $('icon-retry').hidden = true;
  try {
    const loaded = await loadIcons();
    if (catalog) loaded.assertCatalog(catalog);
    icons = loaded;
    $('icon-status').textContent = '';
  } catch (error) {
    icons = null;
    iconFailure(error);
  } finally {
    iconsLoading = false;
    catalogueGrid.schedule();
    inventoryGrid.schedule();
    renderInventory(connection);
  }
}
$('icon-retry').addEventListener('click', initializeIcons);
rebuildInventory();
renderInventory(connection);
if (location.protocol === 'file:') {
  $('message').textContent = 'Serve this directory over HTTP or HTTPS instead of opening the file directly. The GC must allow the exact page origin.';
}
initializeCatalog();
initializeIcons();
