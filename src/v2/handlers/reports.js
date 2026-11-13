'use strict';
/**
 * One definition per report → used for the on-screen table and for CSV / Excel / SQL export,
 * so exported files always match what the screen shows.
 */
const ExcelJS = require('exceljs');
const L = require('../lib');
const { U, db } = L;

const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const dt = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '');
function range(f) {
  const from = f.from ? new Date(f.from) : new Date(Date.now() - 30 * 864e5);
  const to = f.to ? new Date(new Date(f.to).getTime() + 864e5) : new Date(Date.now() + 864e5);
  return { $gte: from, $lt: to };
}
const rel = (id) => (id ? { id: Number(id) } : undefined);
function compact(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)); }

const REPORTS = {
  movements: {
    title: 'Gate movements', module: 'reports', table: 'movements',
    columns: [['time', 'Time'], ['branch', 'Branch'], ['access_point', 'Access point'], ['direction', 'Dir.'], ['tag', 'Tag'], ['asset', 'Asset'], ['ownership', 'Ownership'], ['person', 'Person'], ['department', 'Department'], ['guard', 'Guard'], ['result', 'Result'], ['reason', 'Reason']],
    filters: ['from', 'to', 'branch', 'access_point', 'direction', 'result'],
    async rows(f, user) {
      const where = { $and: [compact({ scanned_at: range(f), branch: rel(f.branch), access_point: rel(f.access_point), direction: f.direction, result: f.result }), L.branchWhere(user)] };
      const r = await db(U.movement).find({ where, populate: { asset: true, person: { populate: { dept: true } }, access_point: true, branch: true, visit: { populate: { visitor: true } } }, orderBy: { scanned_at: 'desc' }, limit: 20000 });
      return r.map((m) => ({ time: dt(m.scanned_at), branch: m.branch?.name, access_point: m.access_point?.name, direction: m.direction, tag: m.asset?.tag_number, asset: m.asset?.asset_name, ownership: m.asset?.ownership, person: m.person?.staff_name || m.visit?.visitor?.guest_name, department: m.person?.dept?.name || m.person?.department || (m.visit ? 'Visitor' : ''), guard: m.guard, result: m.result, reason: m.reason }));
    },
  },
  whereabouts: {
    title: 'Asset whereabouts', module: 'reports', table: 'company_assets',
    columns: [['tag', 'Tag'], ['name', 'Asset'], ['category', 'Category'], ['state', 'Where'], ['last_gate', 'Last gate'], ['last_seen', 'Last seen'], ['custodian', 'Custodian'], ['status', 'Status']],
    filters: ['branch', 'category', 'state'],
    async rows(f, user) {
      const where = { $and: [{ ownership: 'company', asset_status: { $ne: 'decommissioned' } }, compact({ branch: rel(f.branch), category_ref: rel(f.category), location_state: f.state }), L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { category_ref: true, last_access_point: true, assigned_to: true }, orderBy: { tag_number: 'asc' }, limit: 20000 });
      return r.map((a) => ({ tag: a.tag_number, name: a.asset_name, category: a.category_ref?.name || a.category, state: a.location_state, last_gate: a.last_access_point?.name, last_seen: dt(a.last_seen_at), custodian: a.assigned_to?.staff_name, status: a.asset_status }));
    },
  },
  overnight: {
    title: 'Items out overnight', module: 'reports', table: 'company_assets',
    columns: [['tag', 'Tag'], ['name', 'Asset'], ['custodian', 'Custodian'], ['department', 'Department'], ['left_at', 'Went out'], ['gate', 'Gate']],
    filters: ['branch'],
    async rows(f, user) {
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const where = { $and: [{ ownership: 'company', location_state: 'outside', last_seen_at: { $lt: since } }, compact({ branch: rel(f.branch) }), L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { assigned_to: { populate: { dept: true } }, last_access_point: true }, orderBy: { last_seen_at: 'asc' }, limit: 20000 });
      return r.map((a) => ({ tag: a.tag_number, name: a.asset_name, custodian: a.assigned_to?.staff_name, department: a.assigned_to?.dept?.name || a.assigned_to?.department, left_at: dt(a.last_seen_at), gate: a.last_access_point?.name }));
    },
  },
  exceptions: {
    title: 'Exceptions and cases', module: 'investigations', table: 'investigations',
    columns: [['number', 'Case'], ['opened', 'Opened'], ['type', 'Type'], ['severity', 'Severity'], ['status', 'Status'], ['title', 'Subject'], ['investigator', 'Investigator'], ['outcome', 'Outcome']],
    filters: ['from', 'to', 'branch', 'status', 'severity', 'type'],
    async rows(f, user) {
      const where = { $and: [compact({ createdAt: range(f), branch: rel(f.branch), status: f.status, severity: f.severity, type: f.type }), L.branchWhere(user)] };
      const r = await db(U.case).find({ where, populate: { investigator: true }, orderBy: { id: 'desc' }, limit: 20000 });
      return r.map((c) => ({ number: c.number, opened: dt(c.createdAt), type: c.type, severity: c.severity, status: c.status, title: c.title, investigator: c.investigator?.full_name || c.investigator?.username, outcome: c.outcome }));
    },
  },
  register: {
    title: 'Asset register', module: 'assets', table: 'company_assets',
    columns: [['tag', 'Tag'], ['name', 'Name'], ['category', 'Category'], ['make', 'Make'], ['model', 'Model'], ['serial', 'Serial'], ['year', 'Year'], ['purchase', 'Purchased'], ['cost', 'Cost'], ['warranty', 'Warranty'], ['eol', 'End of life'], ['condition', 'Condition'], ['branch', 'Branch'], ['office', 'Office'], ['custodian', 'Custodian'], ['status', 'Status'], ['gate_rule', 'Gate rule']],
    filters: ['branch', 'category', 'status', 'office'],
    async rows(f, user) {
      const where = { $and: [{ ownership: 'company' }, compact({ branch: rel(f.branch), category_ref: rel(f.category), asset_status: f.status, office: rel(f.office) }), L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { category_ref: true, branch: true, office: true, assigned_to: true }, orderBy: { tag_number: 'asc' }, limit: 50000 });
      return r.map((a) => ({ tag: a.tag_number, name: a.asset_name, category: a.category_ref?.name || a.category, make: a.make, model: a.model, serial: a.serial_number, year: a.model_year, purchase: d(a.purchase_date), cost: a.cost, warranty: d(a.warranty_expiry), eol: d(a.end_of_life), condition: a.condition, branch: a.branch?.name, office: a.office?.name, custodian: a.assigned_to?.staff_name, status: a.asset_status, gate_rule: a.gate_rule }));
    },
  },
  assignments: {
    title: 'Assignments by person, department, office', module: 'assets', table: 'company_assets',
    columns: [['custodian', 'Custodian'], ['department', 'Department'], ['office', 'Office'], ['tag', 'Tag'], ['name', 'Asset'], ['category', 'Category']],
    filters: ['branch', 'department', 'office'],
    async rows(f, user) {
      const where = { $and: [{ ownership: 'company', asset_status: { $in: ['assigned', 'on_loan'] } }, compact({ branch: rel(f.branch), office: rel(f.office) }), f.department ? { assigned_to: { dept: { id: Number(f.department) } } } : {}, L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { assigned_to: { populate: { dept: true } }, office: true, category_ref: true }, limit: 50000 });
      return r.map((a) => ({ custodian: a.assigned_to?.staff_name, department: a.assigned_to?.dept?.name || a.assigned_to?.department, office: a.office?.name, tag: a.tag_number, name: a.asset_name, category: a.category_ref?.name || a.category })).sort((x, y) => String(x.custodian).localeCompare(String(y.custodian)));
    },
  },
  lifecycle: {
    title: 'Lifecycle history', module: 'assets', table: 'asset_histories',
    columns: [['date', 'Date'], ['action', 'Action'], ['tag', 'Tag'], ['asset', 'Asset'], ['from', 'From'], ['to', 'To'], ['reason', 'Reason'], ['by', 'By']],
    filters: ['from', 'to', 'action'],
    async rows(f) {
      const r = await db(U.history).find({ where: compact({ event_date: range(f), action_type: f.action }), populate: { company_asset: true }, orderBy: { event_date: 'desc' }, limit: 20000 });
      return r.map((h) => ({ date: dt(h.event_date), action: h.action_type, tag: h.company_asset?.tag_number, asset: h.company_asset?.asset_name, from: h.previous_assignee, to: h.new_assignee, reason: h.reason, by: h.performed_by }));
    },
  },
  due: {
    title: 'Due for replacement or renewal', module: 'assets', table: 'company_assets',
    columns: [['tag', 'Tag'], ['name', 'Asset'], ['category', 'Category'], ['warranty', 'Warranty ends'], ['eol', 'End of life'], ['custodian', 'Custodian']],
    filters: ['months', 'branch'],
    async rows(f, user) {
      const until = new Date(Date.now() + (Number(f.months) || 3) * 30 * 864e5).toISOString().slice(0, 10);
      const where = { $and: [{ ownership: 'company', asset_status: { $ne: 'decommissioned' } }, { $or: [{ warranty_expiry: { $lte: until } }, { end_of_life: { $lte: until } }] }, compact({ branch: rel(f.branch) }), L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { category_ref: true, assigned_to: true }, orderBy: { end_of_life: 'asc' }, limit: 20000 });
      return r.map((a) => ({ tag: a.tag_number, name: a.asset_name, category: a.category_ref?.name || a.category, warranty: d(a.warranty_expiry), eol: d(a.end_of_life), custodian: a.assigned_to?.staff_name }));
    },
  },
  valuation: {
    title: 'Valuation by category and branch', module: 'assets', table: null,
    columns: [['branch', 'Branch'], ['category', 'Category'], ['count', 'Items'], ['with_cost', 'With cost'], ['total', 'Total cost']],
    filters: ['branch'],
    async rows(f, user) {
      const where = { $and: [{ ownership: 'company', asset_status: { $ne: 'decommissioned' } }, compact({ branch: rel(f.branch) }), L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { category_ref: true, branch: true }, select: ['cost', 'category'], limit: 100000 });
      const g = {};
      r.forEach((a) => { const k = `${a.branch?.name || '—'}|${a.category_ref?.name || a.category || '—'}`; g[k] = g[k] || { branch: a.branch?.name || '—', category: a.category_ref?.name || a.category || '—', count: 0, with_cost: 0, total: 0 }; g[k].count++; if (a.cost) { g[k].with_cost++; g[k].total += Number(a.cost); } });
      return Object.values(g).sort((a, b) => b.total - a.total);
    },
  },
  noncompany: {
    title: 'Personal, visitor and third-party items', module: 'noncompany', table: 'company_assets',
    columns: [['ownership', 'Ownership'], ['tag', 'Pass tag'], ['name', 'Item'], ['serial', 'Serial'], ['owner', 'Owner / responsible'], ['status', 'Approval'], ['state', 'Where'], ['permit_end', 'Ends']],
    filters: ['ownership'],
    async rows(f) {
      const r = await db(U.asset).find({ where: { ownership: f.ownership || { $ne: 'company' } }, populate: { assigned_to: true, visit: { populate: { visitor: true } } }, orderBy: { id: 'desc' }, limit: 20000 });
      return r.map((a) => ({ ownership: a.ownership, tag: a.tag_number, name: a.asset_name, serial: a.serial_number, owner: a.assigned_to?.staff_name || a.visit?.visitor?.guest_name || a.owner_name, status: a.approval_status, state: a.location_state, permit_end: d(a.permit_end) }));
    },
  },
  stock: {
    title: 'Stock on hand', module: 'store', table: null,
    columns: [['store', 'Store'], ['code', 'Code'], ['item', 'Item'], ['kind', 'Kind'], ['unit', 'Unit'], ['qty', 'On hand'], ['reorder', 'Reorder at'], ['low', 'Low'], ['value', 'Value']],
    filters: ['store'],
    async rows(f) {
      const r = await db(U.level).find({ where: compact({ store: rel(f.store) }), populate: { item: true, store: true }, limit: 50000 });
      return r.filter((l) => l.item).map((l) => ({ store: l.store?.name, code: l.item.code, item: l.item.name, kind: l.item.kind, unit: l.item.unit, qty: Number(l.qty || 0), reorder: l.item.reorder_level, low: l.item.reorder_level != null && Number(l.qty || 0) <= Number(l.item.reorder_level) ? 'yes' : '', value: Number(l.qty || 0) * Number(l.item.unit_cost || 0) }));
    },
  },
  issues: {
    title: 'Store issues by department', module: 'store', table: 'stock_transactions',
    columns: [['date', 'Date'], ['department', 'Department'], ['taker', 'Taken by'], ['item', 'Item'], ['qty', 'Qty'], ['unit', 'Unit'], ['type', 'Type'], ['issued_by', 'Issued by'], ['requisition', 'Requisition']],
    filters: ['from', 'to', 'store', 'department'],
    async rows(f) {
      const r = await db(U.tx).find({ where: compact({ type: { $in: ['issue', 'lend'] }, happened_at: range(f), store: rel(f.store), department: rel(f.department) }), populate: { item: true, taker: true, department: true, requisition: true }, orderBy: { happened_at: 'desc' }, limit: 50000 });
      return r.map((t) => ({ date: dt(t.happened_at), department: t.department?.name, taker: t.taker?.staff_name, item: t.item?.name, qty: Number(t.qty), unit: t.item?.unit, type: t.type, issued_by: t.issued_by, requisition: t.requisition?.number }));
    },
  },
  loans: {
    title: 'Out on loan / overdue', module: 'store', table: 'stock_transactions',
    columns: [['item', 'Item'], ['qty', 'Outstanding'], ['borrower', 'Borrower'], ['department', 'Department'], ['since', 'Since'], ['due', 'Due'], ['overdue', 'Overdue']],
    filters: ['store'],
    async rows(f) {
      const today = new Date().toISOString().slice(0, 10);
      const r = await db(U.tx).find({ where: compact({ type: 'lend', loan_status: 'open', store: rel(f.store) }), populate: { item: true, taker: true, department: true }, orderBy: { due_date: 'asc' }, limit: 20000 });
      return r.map((t) => ({ item: t.item?.name, qty: Number(t.qty) - Number(t.returned_qty || 0), borrower: t.taker?.staff_name, department: t.department?.name, since: d(t.happened_at), due: d(t.due_date), overdue: t.due_date && d(t.due_date) < today ? 'yes' : '' }));
    },
  },
  requisitions: {
    title: 'Requisitions and approval times', module: 'requisitions', table: 'requisitions',
    columns: [['number', 'Number'], ['submitted', 'Submitted'], ['type', 'Type'], ['requester', 'Requester'], ['department', 'Department'], ['status', 'Status'], ['value', 'Value'], ['hours', 'Hours to approve']],
    filters: ['from', 'to', 'status', 'department'],
    async rows(f) {
      const r = await db(U.req).find({ where: compact({ submitted_at: range(f), status: f.status, department: rel(f.department) }), populate: { requester: true, department: true }, orderBy: { id: 'desc' }, limit: 20000 });
      return r.map((q) => { const last = (q.steps || []).filter((s) => s.at).pop(); return { number: q.number, submitted: dt(q.submitted_at), type: q.type, requester: q.requester?.staff_name, department: q.department?.name, status: q.status, value: q.total_value, hours: last && q.submitted_at ? Math.round((new Date(last.at) - new Date(q.submitted_at)) / 36e5) : '' }; });
    },
  },
  visitors: {
    title: 'Visitors', module: 'reception', table: 'visits',
    columns: [['date', 'Arrived'], ['visitor', 'Visitor'], ['organisation', 'Organisation'], ['host', 'Host'], ['purpose', 'Purpose'], ['in', 'In'], ['out', 'Out'], ['minutes', 'Minutes'], ['badge', 'Badge'], ['status', 'Status']],
    filters: ['from', 'to', 'branch', 'status'],
    async rows(f, user) {
      const where = { $and: [compact({ arrived_at: range(f), branch: rel(f.branch), status: f.status }), L.branchWhere(user)] };
      const r = await db(U.visit).find({ where, populate: { visitor: true, host: true, badge: true }, orderBy: { arrived_at: 'desc' }, limit: 20000 });
      return r.map((v) => ({ date: dt(v.arrived_at), visitor: v.visitor?.guest_name, organisation: v.visitor?.organisation, host: v.host?.staff_name, purpose: v.purpose, in: dt(v.checked_in_at), out: dt(v.checked_out_at), minutes: v.checked_in_at && v.checked_out_at ? Math.round((new Date(v.checked_out_at) - new Date(v.checked_in_at)) / 6e4) : '', badge: v.badge?.number, status: v.status }));
    },
  },
  shifts: {
    title: 'Guard shifts', module: 'reports', table: 'shifts',
    columns: [['guard', 'Guard'], ['access_point', 'Access point'], ['start', 'Start'], ['end', 'End'], ['hours', 'Hours'], ['scans', 'Scans']],
    filters: ['from', 'to', 'access_point'],
    async rows(f) {
      const r = await db(U.shift).find({ where: compact({ start_time: range(f), access_point: rel(f.access_point) }), populate: { access_point: true, user: true }, orderBy: { start_time: 'desc' }, limit: 5000 });
      const out = [];
      for (const s of r) {
        const scans = await db(U.movement).count({ guard: s.user?.username || '__', scanned_at: { $gte: s.start_time, $lte: s.end_time || new Date() } });
        out.push({ guard: s.guard_name, access_point: s.access_point?.name || s.entrance, start: dt(s.start_time), end: dt(s.end_time), hours: s.end_time ? ((new Date(s.end_time) - new Date(s.start_time)) / 36e5).toFixed(1) : 'on shift', scans });
      }
      return out;
    },
  },
  guest_vehicles: {
    title: 'Guest vehicles', module: 'reports', table: 'guest_vehicle_sessions',
    columns: [['in', 'In'], ['out', 'Out'], ['plate', 'Plate'], ['driver', 'Driver / visitor'], ['purpose', 'Purpose'], ['passcard', 'Passcard'], ['gate', 'Gate'], ['by', 'Registered by'], ['status', 'Status']],
    filters: ['from', 'to'],
    async rows(f) {
      const r = await db('api::guest-vehicle-session.guest-vehicle-session').find({ where: { check_in_time: range(f) }, populate: { passcard: true, access_point: true }, orderBy: { check_in_time: 'desc' }, limit: 20000 });
      return r.map((g) => ({ in: dt(g.check_in_time), out: dt(g.check_out_time), plate: g.plate_number, driver: g.visitor_name, purpose: g.purpose, passcard: g.passcard?.passcard_number, gate: g.access_point?.name || g.location, by: g.registered_by, status: g.session_status }));
    },
  },
  fleet: {
    title: 'Vehicle fleet', module: 'assets', table: 'company_assets',
    columns: [['plate', 'Plate'], ['tag', 'Tag'], ['vehicle', 'Vehicle'], ['driver', 'Assigned driver'], ['department', 'Department'], ['state', 'Where'], ['last_gate', 'Last gate'], ['last_seen', 'Last seen'], ['status', 'Status']],
    filters: ['branch', 'state'],
    async rows(f, user) {
      const where = { $and: [{ category_ref: { is_vehicle: true } }, compact({ branch: rel(f.branch), location_state: f.state }), L.branchWhere(user)] };
      const r = await db(U.asset).find({ where, populate: { assigned_to: { populate: { dept: true } }, last_access_point: true }, orderBy: { serial_number: 'asc' }, limit: 20000 });
      return r.map((a) => ({ plate: a.serial_number, tag: a.tag_number, vehicle: a.asset_name, driver: a.assigned_to?.staff_name, department: a.assigned_to?.dept?.name || a.assigned_to?.department, state: a.location_state, last_gate: a.last_access_point?.name, last_seen: dt(a.last_seen_at), status: a.asset_status }));
    },
  },
  audit: {
    title: 'Audit trail', module: 'audit', table: 'audit_logs',
    columns: [['at', 'Time'], ['user', 'User'], ['action', 'Action'], ['entity', 'Entity'], ['entity_id', 'ID'], ['ip', 'IP']],
    filters: ['from', 'to', 'user'],
    async rows(f) {
      const r = await db(U.audit).find({ where: compact({ at: range(f), user: f.user }), orderBy: { at: 'desc' }, limit: 20000 });
      return r.map((a) => ({ at: dt(a.at), user: a.user, action: a.action, entity: a.entity, entity_id: a.entity_id, ip: a.ip }));
    },
  },
};

function csvEsc(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function sqlEsc(v) { if (v == null || v === '') return 'NULL'; if (typeof v === 'number') return String(v); return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`; }

module.exports = {
  REPORTS,

  catalogue(ctx) {
    const user = ctx.state.appUser;
    return { data: Object.entries(REPORTS).filter(([, r]) => L.can(user, r.module, 'view') || L.can(user, 'reports', 'view') && r.module === 'reports').map(([key, r]) => ({ key, title: r.title, module: r.module, columns: r.columns.map(([k, l]) => ({ key: k, label: l })), filters: r.filters })) };
  },

  async run(ctx) {
    const r = REPORTS[ctx.params.key];
    if (!r) return L.bad(ctx, 'Unknown report', 404);
    const user = ctx.state.appUser;
    if (!L.can(user, r.module, 'view') && !(r.module === 'reports' && L.can(user, 'reports', 'view'))) return L.bad(ctx, 'Not allowed', 403);
    const f = ctx.query || {};
    const rows = await r.rows(f, user);
    const format = f.format || 'json';
    if (format === 'json') {
      const limit = Number(f.limit) || 200;
      return { title: r.title, columns: r.columns.map(([k, l]) => ({ key: k, label: l })), total: rows.length, rows: rows.slice(0, limit) };
    }
    if (!L.can(user, r.module, 'export') && !L.can(user, 'reports', 'export')) return L.bad(ctx, 'You can view this report but not export it', 403);
    const stamp = new Date().toISOString().slice(0, 10);
    const org = L.env('ORG_NAME', 'Organisation');
    const fname = `${ctx.params.key}-${stamp}`;
    await L.audit(ctx, 'export', 'report', ctx.params.key, null, { format, rows: rows.length });
    if (format === 'csv') {
      ctx.set('Content-Type', 'text/csv; charset=utf-8');
      ctx.set('Content-Disposition', `attachment; filename="${fname}.csv"`);
      return '﻿' + [r.columns.map(([, l]) => csvEsc(l)).join(','), ...rows.map((row) => r.columns.map(([k]) => csvEsc(row[k])).join(','))].join('\n');
    }
    if (format === 'sql') {
      if (!L.hasRole(user, 'Super Admin')) return L.bad(ctx, 'SQL export is for Super Admin only', 403);
      const tbl = `report_${ctx.params.key}`;
      const cols = r.columns.map(([k]) => k);
      const lines = [`-- ${org} · ${r.title} · exported ${new Date().toISOString()} by ${user.username}`, `CREATE TABLE IF NOT EXISTS ${tbl} (${cols.map((c) => `\`${c}\` TEXT`).join(', ')});`];
      rows.forEach((row) => lines.push(`INSERT INTO ${tbl} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map((c) => sqlEsc(row[c])).join(', ')});`));
      ctx.set('Content-Type', 'application/sql; charset=utf-8');
      ctx.set('Content-Disposition', `attachment; filename="${fname}.sql"`);
      return lines.join('\n') + '\n';
    }
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      wb.creator = org;
      const ws = wb.addWorksheet(r.title.slice(0, 31));
      ws.addRow([`${org} — ${r.title}`]).font = { bold: true, size: 14 };
      const used = Object.entries(f).filter(([k, v]) => !['format', 'limit'].includes(k) && v).map(([k, v]) => `${k}: ${v}`).join(' · ');
      ws.addRow([`Exported ${new Date().toLocaleString('en-GB')} by ${user.full_name}${used ? ' · ' + used : ''}`]).font = { italic: true, color: { argb: 'FF555555' } };
      ws.addRow([]);
      const head = ws.addRow(r.columns.map(([, l]) => l));
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + String(L.env('BRAND_PRIMARY', '#006534')).replace('#', '') } }; });
      rows.forEach((row) => ws.addRow(r.columns.map(([k]) => row[k] ?? '')));
      ws.columns.forEach((c, i) => { c.width = Math.min(40, Math.max(10, ...[r.columns[i]?.[1] || '', ...rows.slice(0, 200).map((x) => x[r.columns[i]?.[0]])].map((v) => String(v ?? '').length + 2))); });
      ws.views = [{ state: 'frozen', ySplit: 4 }];
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: r.columns.length } };
      ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      ctx.set('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
      return Buffer.from(await wb.xlsx.writeBuffer());
    }
    return L.bad(ctx, 'Format must be csv, xlsx, sql or json');
  },

  async dashboard(ctx) {
    const user = ctx.state.appUser;
    const scope = L.branchWhere(user);
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const assetsW = { $and: [{ ownership: 'company' }, scope] };
    const [total, assigned, outside, lost, repair, decom, available] = await Promise.all([
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { asset_status: { $ne: 'decommissioned' } }] } }),
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { asset_status: 'assigned' }] } }),
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { location_state: 'outside', asset_status: { $ne: 'decommissioned' } }] } }),
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { asset_status: 'lost' }] } }),
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { asset_status: 'in_repair' }] } }),
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { asset_status: 'decommissioned' }] } }),
      db(U.asset).raw.count({ where: { $and: [...assetsW.$and, { asset_status: 'available' }] } }),
    ]);
    const openCases = await db(U.case).raw.count({ where: { $and: [{ status: { $in: ['new', 'investigating', 'awaiting_info'] } }, scope] } });
    const casesToday = await db(U.case).raw.count({ where: { $and: [{ createdAt: { $gte: day } }, scope] } });
    const mv = await db(U.movement).find({ where: { $and: [{ scanned_at: { $gte: day } }, scope] }, populate: { access_point: { populate: { branch: true } } }, limit: 50000 });
    const byAp = {};
    mv.forEach((m) => { const k = m.access_point ? `${m.access_point.branch?.name || ''} · ${m.access_point.name}` : '—'; byAp[k] = byAp[k] || { name: k, in: 0, out: 0 }; byAp[k][m.direction === 'IN' ? 'in' : 'out']++; });
    const levels = await db(U.level).find({ populate: { item: true } });
    const low = levels.filter((l) => l.item && l.item.reorder_level != null && Number(l.qty || 0) <= Number(l.item.reorder_level)).length;
    const today = new Date().toISOString().slice(0, 10);
    const overdue = await db(U.tx).raw.count({ where: { type: 'lend', loan_status: 'open', due_date: { $lt: today } } });
    const until = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const due = await db(U.asset).find({ where: { $and: [...assetsW.$and, { asset_status: { $ne: 'decommissioned' } }, { $or: [{ warranty_expiry: { $lte: until, $gte: today } }, { end_of_life: { $lte: until, $gte: today } }] }] }, orderBy: { end_of_life: 'asc' }, limit: 8 });
    const exc = await db(U.case).find({ where: { $and: [{ status: { $in: ['new', 'investigating', 'awaiting_info'] } }, scope] }, populate: { access_point: true }, orderBy: { id: 'desc' }, limit: 8 });
    const visitorsIn = await db(U.visit).raw.count({ where: { $and: [{ status: 'in_building' }, scope] } });
    return {
      kpis: { total, assigned, outside, openCases, casesToday, low, overdue, visitorsIn },
      status: { assigned, available, in_repair: repair, lost, decommissioned: decom },
      byAccessPoint: Object.values(byAp).sort((a, b) => b.in + b.out - a.in - a.out),
      due: due.map((a) => ({ id: a.id, tag: a.tag_number, name: a.asset_name, warranty: d(a.warranty_expiry), eol: d(a.end_of_life) })),
      exceptions: exc.map((c) => ({ id: c.id, number: c.number, at: c.createdAt, type: c.type, severity: c.severity, title: c.title, access_point: c.access_point?.name, status: c.status })),
    };
  },
};
