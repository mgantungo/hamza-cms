'use strict';
/**
 * Excel / CSV import: template → preview (row-by-row checks) → commit valid rows.
 * Matching on tag / staff ID / item code updates existing records instead of duplicating.
 */
const ExcelJS = require('exceljs');
const L = require('../lib');
const { U, db } = L;

const SPECS = {
  assets: {
    module: 'imports', label: 'Assets',
    cols: [['tag_number', 'Tag (blank = auto)'], ['asset_name', 'Name*'], ['category', 'Category*'], ['make', 'Make'], ['model', 'Model'], ['manufacturer', 'Manufacturer'], ['serial_number', 'Serial'], ['model_year', 'Model year'], ['manufacture_date', 'Manufacture date'], ['purchase_date', 'Purchase date'], ['supplier', 'Supplier'], ['invoice_no', 'Invoice no'], ['cost', 'Cost'], ['warranty_expiry', 'Warranty expiry'], ['end_of_life', 'End of life'], ['condition', 'Condition'], ['branch', 'Branch*'], ['office', 'Office'], ['custodian', 'Custodian staff ID'], ['gate_rule', 'Gate rule (portable/fixed)'], ['department', 'Department (info)'], ['notes', 'Notes']],
  },
  staff: {
    module: 'imports', label: 'Staff',
    cols: [['staff_id', 'Staff ID*'], ['staff_name', 'Full name*'], ['department', 'Department*'], ['position', 'Position'], ['branch', 'Branch'], ['email', 'Email'], ['phone', 'Phone'], ['card_number', 'Access card number'], ['status', 'Status (active/suspended/left)']],
  },
  'store-items': {
    module: 'imports', label: 'Store items',
    cols: [['code', 'Item code*'], ['name', 'Name*'], ['category', 'Category'], ['kind', 'Kind* (consumable/returnable)'], ['unit', 'Unit*'], ['reorder_level', 'Reorder level'], ['unit_cost', 'Unit cost'], ['location_bin', 'Shelf / bin']],
  },
  'opening-stock': {
    module: 'imports', label: 'Opening stock',
    cols: [['store', 'Store*'], ['code', 'Item code*'], ['qty', 'Quantity*'], ['unit_cost', 'Unit cost'], ['expiry_date', 'Expiry date']],
  },
};

function cellVal(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') { if (v.text) return String(v.text).trim(); if (v.result !== undefined) return cellVal(v.result); if (v.richText) return v.richText.map((x) => x.text).join('').trim(); }
  return String(v).trim();
}
function toDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s.slice(0, 10)); return isNaN(d) ? 'bad' : s.slice(0, 10); }
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) { const d = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`); if (isNaN(d) || d.getUTCDate() !== Number(m[1])) return 'bad'; return d.toISOString().slice(0, 10); }
  return 'bad';
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function readRows(file, spec) {
  const wb = new ExcelJS.Workbook();
  const name = (file.originalFilename || file.name || '').toLowerCase();
  let ws;
  if (name.endsWith('.csv')) ws = await wb.csv.readFile(file.filepath || file.path);
  else { await wb.xlsx.readFile(file.filepath || file.path); ws = wb.worksheets[0]; }
  if (!ws) throw new Error('The file has no sheet');
  // find header row within the first 5 rows
  let headerRow = 1; let map = {};
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const vals = ws.getRow(r).values.map(cellVal);
    const m = {};
    vals.forEach((v, idx) => { const n = norm(v.replace(/\(.*\)|\*/g, '')); const col = spec.cols.find(([k, l]) => norm(k) === n || norm(l.replace(/\(.*\)|\*/g, '')) === n); if (col) m[col[0]] = idx; });
    if (Object.keys(m).length >= 2) { headerRow = r; map = m; break; }
  }
  if (!Object.keys(map).length) throw new Error('Could not find the header row. Use the template.');
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const vals = ws.getRow(r).values;
    const o = {};
    let any = false;
    for (const [k, idx] of Object.entries(map)) { o[k] = cellVal(vals[idx]); if (o[k]) any = true; }
    if (any) rows.push({ row: r, data: o });
  }
  return { rows, mapped: Object.keys(map).length, total: spec.cols.length };
}

async function lookups() {
  const [branches, cats, depts, offices, stores] = await Promise.all([db(U.branch).find(), db(U.category).find(), db(U.dept).find(), db(U.office).find({ populate: { branch: true } }), db(U.store).find()]);
  const by = (arr, f) => Object.fromEntries(arr.map((x) => [norm(x[f]), x]));
  return { branches: by(branches, 'name'), branchCodes: by(branches, 'code'), cats: by(cats, 'name'), depts: by(depts, 'name'), offices, stores: by(stores, 'name') };
}

async function check(entity, rows) {
  const lk = await lookups();
  const out = [];
  const seen = new Set();
  for (const { row, data } of rows) {
    const errors = {};
    const x = { ...data };
    const req = (k, msg) => { if (!x[k]) errors[k] = msg || 'Required'; };
    if (entity === 'assets') {
      req('asset_name'); req('category'); req('branch');
      const cat = lk.cats[norm(x.category)]; if (x.category && !cat) errors.category = `Category "${x.category}" not found`;
      const br = lk.branches[norm(x.branch)] || lk.branchCodes[norm(x.branch)]; if (x.branch && !br) errors.branch = `Branch "${x.branch}" not found`;
      for (const k of ['manufacture_date', 'purchase_date', 'warranty_expiry', 'end_of_life']) { const v = toDate(x[k]); if (v === 'bad') errors[k] = `${x[k]} is not a date`; else x[k] = v; }
      if (x.cost && isNaN(Number(String(x.cost).replace(/,/g, '')))) errors.cost = 'Not a number'; else if (x.cost) x.cost = Number(String(x.cost).replace(/,/g, ''));
      if (x.model_year && !/^\d{4}$/.test(x.model_year)) errors.model_year = 'Use a 4-digit year';
      if (x.gate_rule && !['portable', 'fixed'].includes(x.gate_rule.toLowerCase())) errors.gate_rule = 'portable or fixed';
      if (x.serial_number) {
        const k = norm(x.serial_number); if (seen.has(k)) errors.serial_number = 'Duplicate serial in this file'; seen.add(k);
        const dup = await db(U.asset).one({ where: { serial_number: { $eqi: x.serial_number } } });
        if (dup && norm(dup.tag_number) !== norm(x.tag_number)) errors.serial_number = `Serial ${x.serial_number} already exists on ${dup.tag_number}`;
      }
      let custodian = null;
      if (x.custodian) { custodian = await db(U.staff).one({ where: { staff_id: { $eqi: x.custodian } } }); if (!custodian) errors.custodian = `Staff ${x.custodian} not found`; }
      const office = x.office ? lk.offices.find((o) => norm(o.name) === norm(x.office) && (!br || o.branch?.id === br.id)) : null;
      if (x.office && !office) errors.office = `Office "${x.office}" not found in that branch`;
      const existing = x.tag_number ? await db(U.asset).one({ where: { tag_number: { $eqi: x.tag_number } } }) : null;
      out.push({ row, data, errors, action: existing ? 'update' : 'create', resolved: { cat: cat?.id, branch: br?.id, office: office?.id, custodian: custodian?.id, existing: existing?.id, catPrefix: cat?.tag_prefix, gateDefault: cat?.gate_rule_default, catName: cat?.name, clean: x } });
    } else if (entity === 'staff') {
      req('staff_id'); req('staff_name'); req('department');
      const dept = lk.depts[norm(x.department)]; if (x.department && !dept) errors.department = `Department "${x.department}" not found`;
      const br = x.branch ? lk.branches[norm(x.branch)] || lk.branchCodes[norm(x.branch)] : null; if (x.branch && !br) errors.branch = `Branch "${x.branch}" not found`;
      if (x.status && !['active', 'suspended', 'left'].includes(x.status.toLowerCase())) errors.status = 'active, suspended or left';
      const k = norm(x.staff_id); if (seen.has(k)) errors.staff_id = 'Duplicate staff ID in this file'; seen.add(k);
      if (x.card_number) { const dup = await db(U.staff).one({ where: { card_number: { $eqi: x.card_number } } }); if (dup && norm(dup.staff_id) !== k) errors.card_number = `Card already belongs to ${dup.staff_name}`; }
      const existing = x.staff_id ? await db(U.staff).one({ where: { staff_id: { $eqi: x.staff_id } } }) : null;
      out.push({ row, data, errors, action: existing ? 'update' : 'create', resolved: { dept: dept?.id, deptName: dept?.name, branch: br?.id, existing: existing?.id, clean: x } });
    } else if (entity === 'store-items') {
      req('code'); req('name'); req('kind'); req('unit');
      if (x.kind && !['consumable', 'returnable'].includes(x.kind.toLowerCase())) errors.kind = 'consumable or returnable';
      for (const n of ['reorder_level', 'unit_cost']) if (x[n] && isNaN(Number(String(x[n]).replace(/,/g, '')))) errors[n] = 'Not a number';
      const k = norm(x.code); if (seen.has(k)) errors.code = 'Duplicate code in this file'; seen.add(k);
      const existing = x.code ? await db(U.item).one({ where: { code: { $eqi: x.code } } }) : null;
      out.push({ row, data, errors, action: existing ? 'update' : 'create', resolved: { existing: existing?.id, clean: x } });
    } else if (entity === 'opening-stock') {
      req('store'); req('code'); req('qty');
      const st = lk.stores[norm(x.store)]; if (x.store && !st) errors.store = `Store "${x.store}" not found`;
      const it = x.code ? await db(U.item).one({ where: { code: { $eqi: x.code } } }) : null; if (x.code && !it) errors.code = `Item ${x.code} not found — import store items first`;
      if (x.qty && isNaN(Number(x.qty))) errors.qty = 'Not a number';
      const ex = toDate(x.expiry_date); if (ex === 'bad') errors.expiry_date = 'Not a date'; else x.expiry_date = ex;
      out.push({ row, data, errors, action: 'receive', resolved: { store: st?.id, item: it?.id, clean: x } });
    }
  }
  return out;
}

module.exports = {
  SPECS,
  async template(ctx) {
    const spec = SPECS[ctx.params.entity];
    if (!spec) return L.bad(ctx, 'Unknown import', 404);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(spec.label);
    const head = ws.addRow(spec.cols.map(([, l]) => l));
    head.font = { bold: true };
    ws.columns.forEach((c) => { c.width = 22; });
    // lists sheet for valid values
    const lk = await lookups();
    const lists = wb.addWorksheet('Lists');
    lists.addRow(['Branches', 'Categories', 'Departments', 'Stores']);
    const cols = [Object.values(lk.branches).map((b) => b.name), Object.values(lk.cats).map((c) => c.name), Object.values(lk.depts).map((x) => x.name), Object.values(lk.stores).map((s) => s.name)];
    const max = Math.max(...cols.map((c) => c.length), 0);
    for (let i = 0; i < max; i++) lists.addRow(cols.map((c) => c[i] || ''));
    ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    ctx.set('Content-Disposition', `attachment; filename="template-${ctx.params.entity}.xlsx"`);
    return Buffer.from(await wb.xlsx.writeBuffer());
  },

  async preview(ctx) {
    const spec = SPECS[ctx.params.entity];
    if (!spec) return L.bad(ctx, 'Unknown import', 404);
    const f = ctx.request.files?.file; const file = Array.isArray(f) ? f[0] : f;
    if (!file) return L.bad(ctx, 'Attach an .xlsx or .csv file');
    let parsed;
    try { parsed = await readRows(file, spec); } catch (e) { return L.bad(ctx, e.message); }
    const checked = await check(ctx.params.entity, parsed.rows);
    return { file: file.originalFilename || file.name, mapped: parsed.mapped, totalCols: parsed.total, columns: spec.cols.map(([k, l]) => ({ key: k, label: l })), rows: checked.map((c) => ({ row: c.row, data: c.data, errors: c.errors, action: c.action })), counts: { total: checked.length, valid: checked.filter((c) => !Object.keys(c.errors).length).length, errors: checked.filter((c) => Object.keys(c.errors).length).length, updates: checked.filter((c) => c.action === 'update' && !Object.keys(c.errors).length).length } };
  },

  /** Body: { rows: [{row, data}] } – re-checked server side, only valid rows written. */
  async commit(ctx) {
    const entity = ctx.params.entity;
    if (!SPECS[entity]) return L.bad(ctx, 'Unknown import', 404);
    const user = ctx.state.appUser;
    const checked = await check(entity, (ctx.request.body?.rows || []).map((r) => ({ row: r.row, data: r.data })));
    const valid = checked.filter((c) => !Object.keys(c.errors).length);
    let created = 0, updated = 0;
    if (entity === 'assets') {
      // allocate tags per prefix
      const need = {};
      valid.filter((v) => !v.resolved.clean.tag_number).forEach((v) => { const p = L.tagPrefixFor('company', { tag_prefix: v.resolved.catPrefix }); need[p] = (need[p] || 0) + 1; });
      const pool = {};
      for (const [p, n] of Object.entries(need)) pool[p] = await L.nextTags(p, n, v6(p));
      for (const v of valid) {
        const x = v.resolved.clean;
        const data = { asset_name: x.asset_name, category: v.resolved.catName, category_ref: v.resolved.cat, make: x.make || null, model: x.model || null, manufacturer: x.manufacturer || null, serial_number: x.serial_number || null, model_year: x.model_year ? Number(x.model_year) : null, manufacture_date: x.manufacture_date, purchase_date: x.purchase_date, supplier: x.supplier || null, invoice_no: x.invoice_no || null, cost: x.cost || null, warranty_expiry: x.warranty_expiry, end_of_life: x.end_of_life, condition: x.condition ? x.condition.toLowerCase() : 'good', branch: v.resolved.branch, office: v.resolved.office || null, assigned_to: v.resolved.custodian || null, gate_rule: (x.gate_rule || v.resolved.gateDefault || 'portable').toLowerCase(), notes: x.notes || null, ownership: 'company' };
        if (v.resolved.existing) { await db(U.asset).update(v.resolved.existing, data); await L.history(ctx, v.resolved.existing, 'import', { notes: 'Updated by import' }); updated++; }
        else {
          const tag = x.tag_number || pool[L.tagPrefixFor('company', { tag_prefix: v.resolved.catPrefix })].shift();
          const row = await db(U.asset).create({ ...data, tag_number: tag, asset_status: data.assigned_to ? 'assigned' : 'available', location_state: 'inside', approval_status: 'approved' });
          await L.history(ctx, row.id, 'import', { notes: 'Created by import' }); created++;
        }
      }
    } else if (entity === 'staff') {
      for (const v of valid) {
        const x = v.resolved.clean;
        const data = { staff_id: x.staff_id, staff_name: x.staff_name, department: v.resolved.deptName, dept: v.resolved.dept, position: x.position || null, branch: v.resolved.branch || null, email: x.email || null, phone: x.phone || null, card_number: x.card_number || null, status: (x.status || 'active').toLowerCase() };
        if (v.resolved.existing) { await db(U.staff).update(v.resolved.existing, data); updated++; } else { await db(U.staff).create(data); created++; }
      }
    } else if (entity === 'store-items') {
      for (const v of valid) {
        const x = v.resolved.clean;
        const data = { code: x.code, name: x.name, category: x.category || null, kind: x.kind.toLowerCase(), unit: x.unit, reorder_level: x.reorder_level ? Number(String(x.reorder_level).replace(/,/g, '')) : null, unit_cost: x.unit_cost ? Number(String(x.unit_cost).replace(/,/g, '')) : null, location_bin: x.location_bin || null, active: true };
        if (v.resolved.existing) { await db(U.item).update(v.resolved.existing, data); updated++; } else { await db(U.item).create(data); created++; }
      }
    } else if (entity === 'opening-stock') {
      const byStore = {};
      valid.forEach((v) => { (byStore[v.resolved.store] = byStore[v.resolved.store] || []).push({ itemId: v.resolved.item, qty: Number(v.resolved.clean.qty), unit_cost: v.resolved.clean.unit_cost, expiry_date: v.resolved.clean.expiry_date }); });
      for (const [storeId, lines] of Object.entries(byStore)) { await require('./store').post(ctx, { type: 'receive', storeId: Number(storeId), lines, supplier: 'Opening stock' }); created += lines.length; }
    }
    await L.audit(ctx, 'import', entity, null, null, { created, updated, rejected: checked.length - valid.length, by: user.username });
    return { created, updated, rejected: checked.length - valid.length };
  },
};
function v6(prefix) { return /-[A-Z]+-$/.test(prefix) ? 4 : 6; }
