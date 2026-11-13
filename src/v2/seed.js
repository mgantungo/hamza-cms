'use strict';
/**
 * Idempotent bootstrap: built-in roles, the first Super Admin, reference data,
 * and (once, when RUN_V1_MIGRATION=true) conversion of v1 records.
 */
const L = require('./lib');
const { U, db, env } = L;

const all = ['view', 'create', 'edit', 'approve', 'delete', 'export'];
const VCE = ['view', 'create', 'edit'];
const ROLES = [
  { name: 'Super Admin', scope: 'all', description: 'Everything, all branches', permissions: { '*': true } },
  { name: 'Branch Admin', scope: 'branches', description: 'Runs assigned branches', permissions: { gate: ['view', 'create', 'edit', 'delete', 'export'], reception: all, assets: all, noncompany: all, staff: all, store: all, requisitions: ['view', 'create', 'approve'], imports: ['view', 'create'], labels: ['view', 'create', 'export'], reports: ['view', 'export'], investigations: all, admin: ['view', 'edit', 'create'], audit: ['view'] } },
  { name: 'Manager', scope: 'department', description: 'Head of department; approves department requisitions', permissions: { assets: ['view'], staff: ['view'], requisitions: ['view', 'create', 'approve'], reports: ['view'], reception: ['create'], noncompany: ['create'] } },
  { name: 'Asset Officer', scope: 'branches', description: 'Asset register, labels, imports', permissions: { assets: ['view', 'create', 'edit', 'export'], noncompany: ['view', 'create', 'edit'], labels: all, imports: ['view', 'create'], staff: ['view'], reports: ['view', 'export'], requisitions: ['view', 'approve'] } },
  { name: 'Store Manager', scope: 'branches', description: 'Stores: final approval, issue, adjust', approval_limit: 5000000, permissions: { store: all, requisitions: ['view', 'create', 'approve'], imports: ['view', 'create'], labels: ['view', 'create'], reports: ['view', 'export'], staff: ['view'] } },
  { name: 'Storekeeper', scope: 'branches', description: 'Issue, lend, receive', permissions: { store: VCE, requisitions: ['view'], staff: ['view'], labels: ['view', 'create'] } },
  { name: 'Security Supervisor', scope: 'branches', description: 'Investigations, lost items, guard rosters', permissions: { gate: all, investigations: all, noncompany: ['view', 'edit', 'approve'], reception: ['view'], assets: ['view'], staff: ['view'], reports: ['view', 'export'] } },
  { name: 'Security', scope: 'access_points', description: 'Gate scanning at assigned access points', permissions: { gate: ['view', 'create'], reception: ['view', 'create'], assets: ['view'], staff: ['view'] } },
  { name: 'Reception', scope: 'branches', description: 'Visitors, appointments, badges', permissions: { reception: all, staff: ['view'], noncompany: ['view', 'create'] } },
  { name: 'Auditor', scope: 'all', description: 'Read-only everywhere', permissions: Object.fromEntries(L.MODULES.map((m) => [m, ['view', 'export']])) },
  { name: 'Staff', scope: 'self', description: 'Own items, visitors, requisitions', permissions: { requisitions: ['view', 'create'], noncompany: ['create'], reception: ['create'] } },
];

const DEPARTMENTS = ["CEO's Office", 'Content Distribution', 'Content Generation', 'Customer Care Office', 'Engineering', 'Finance', 'Human Resource', 'Internal Audit', 'Marketing', 'Printing', 'Sales', 'Technology'];
const CATEGORIES = [
  { name: 'IT equipment', tag_prefix: '', gate_rule_default: 'portable' },
  { name: 'Furniture', tag_prefix: 'F', gate_rule_default: 'fixed', custom_fields: [{ key: 'material', label: 'Material' }, { key: 'colour', label: 'Colour' }, { key: 'dimensions', label: 'Dimensions' }] },
  { name: 'Vehicles', tag_prefix: 'V', gate_rule_default: 'portable', is_vehicle: true, custom_fields: [{ key: 'chassis', label: 'Chassis number' }, { key: 'engine', label: 'Engine number' }] },
  { name: 'Cameras & AV', tag_prefix: '', gate_rule_default: 'portable' },
  { name: 'Tools', tag_prefix: 'T', gate_rule_default: 'portable' },
  { name: 'Machinery', tag_prefix: 'M', gate_rule_default: 'fixed' },
];

async function upsert(uid, where, data) {
  const ex = await db(uid).one({ where });
  return ex || db(uid).create(data);
}

module.exports = async function seed() {
  // roles: create missing built-ins, never overwrite edits
  for (const r of ROLES) {
    const ex = await db(U.role).one({ where: { name: r.name } });
    if (!ex) await db(U.role).create({ ...r, builtin: true });
  }

  const branchCount = await db(U.branch).count();
  let hq;
  if (!branchCount) {
    hq = await db(U.branch).create({ name: env('SEED_BRANCH_NAME', 'Head Office'), code: env('SEED_BRANCH_CODE', 'HQ'), active: true });
    const aps = JSON.parse(env('SEED_ACCESS_POINTS', '[{"name":"Main Gate","kind":"both"},{"name":"Staff Entrance","kind":"pedestrian"}]'));
    for (const a of aps) await db(U.ap).create({ name: a.name, kind: a.kind || 'pedestrian', legacy_location: a.legacy_location || null, branch: hq.id, active: true });
    await db(U.store).create({ name: 'Main Store', branch: hq.id, active: true });
    await db(U.office).create({ name: 'General', branch: hq.id });
    for (let i = 1; i <= Number(env('SEED_BADGES', 20)); i++) await db(U.badge).create({ number: `B-${String(i).padStart(3, '0')}`, branch: hq.id, status: 'available' });
  } else hq = (await db(U.branch).find({ limit: 1, orderBy: { id: 'asc' } }))[0];

  if (!(await db(U.dept).count())) for (const d of DEPARTMENTS) await db(U.dept).create({ name: d });
  if (!(await db(U.category).count())) for (const c of CATEGORIES) await db(U.category).create(c);

  if (!(await db(U.user).count())) {
    const su = await db(U.role).one({ where: { name: 'Super Admin' } });
    const username = env('SUPERADMIN_USERNAME', 'superadmin');
    const password = env('SUPERADMIN_PASSWORD', 'ChangeMe!2026');
    await db(U.user).create({ username, full_name: 'Super Administrator', password_hash: L.hash(password), active: true, roles: [su.id], branches: [hq.id] });
    strapi.log.warn(`[v2] Created first Super Admin "${username}". Sign in and change the password now.`);
  }

  // link staff to department records (staff.department was a text enum in v1)
  const unlinked = await db(U.staff).find({ where: { dept: { id: { $null: true } }, department: { $notNull: true } }, limit: 5000 });
  if (unlinked.length) {
    const depts = await db(U.dept).find();
    const by = Object.fromEntries(depts.map((d) => [d.name.toLowerCase(), d.id]));
    for (const s of unlinked) {
      const k = String(s.department || '').toLowerCase();
      let id = by[k];
      if (!id && s.department) { const nd = await db(U.dept).create({ name: s.department }); by[k] = id = nd.id; }
      if (id) await db(U.staff).update(s.id, { dept: id, branch: s.branch?.id || hq?.id || null, status: s.status || 'active' });
    }
  }
  // default ownership on v1 assets
  const v1 = await db(U.asset).find({ where: { ownership: { $null: true } }, limit: 50000, select: ['id'] });
  for (const a of v1) await db(U.asset).update(a.id, { ownership: 'company', approval_status: 'approved', location_state: 'unknown', gate_rule: 'portable', branch: hq?.id || null });

  // v1 vehicles: company assets with category text "vehicle" and the plate in tag_number
  const vcat = await db(U.category).one({ where: { is_vehicle: true } });
  if (vcat) {
    const v1veh = await db(U.asset).find({ where: { category_ref: { id: { $null: true } }, category: { $containsi: 'vehicle' } }, limit: 5000 });
    for (const v of v1veh) await db(U.asset).update(v.id, { category_ref: vcat.id, category: vcat.name, serial_number: String(v.serial_number || v.tag_number || '').replace(/\s+/g, '').toUpperCase(), gate_rule: 'portable' });
  }
  if (!(await db('api::vehicle-passcard.vehicle-passcard').count())) {
    for (let i = 1; i <= Number(env('SEED_PASSCARDS', 20)); i++) await db('api::vehicle-passcard.vehicle-passcard').create({ passcard_number: `VP-${String(i).padStart(3, '0')}`, passcard_status: 'available', branch: hq?.id || null });
  }

  if (env('RUN_V1_MIGRATION') === 'true') await migrateV1(hq);
};

/** v1 access-log devices JSON → one movement per device; free-text locations → access points. */
async function migrateV1(hq) {
  const done = await db(U.audit).one({ where: { action: 'v1_migration' } });
  if (done) { strapi.log.info('[v2] v1 migration already ran'); return; }
  const aps = await db(U.ap).find();
  const byLoc = {};
  aps.forEach((a) => { byLoc[(a.legacy_location || a.name).toLowerCase()] = a; });
  async function apFor(loc) {
    const k = String(loc || 'Unknown').toLowerCase();
    if (!byLoc[k]) byLoc[k] = await db(U.ap).create({ name: loc || 'Unknown', legacy_location: loc, kind: 'pedestrian', branch: hq.id, active: true });
    return byLoc[k];
  }
  let n = 0;
  let offset = 0;
  for (;;) {
    const logs = await db(U.accessLog).find({ populate: { staff: true }, orderBy: { id: 'asc' }, limit: 500, offset });
    if (!logs.length) break;
    offset += logs.length;
    for (const log of logs) {
      const ap = await apFor(log.location);
      const devices = Array.isArray(log.devices) ? log.devices : [];
      for (const dev of devices) {
        const asset = await db(U.asset).one({ where: { $or: [{ tag_number: { $eqi: String(dev) } }, { serial_number: { $eqi: String(dev) } }] } });
        await db(U.movement).create({ asset: asset?.id || null, person: log.staff?.id || null, direction: log.action === 'Check in' ? 'IN' : 'OUT', access_point: ap.id, branch: hq.id, guard: 'v1', result: log.flagged ? 'exception' : 'ok', reason: asset ? null : `v1 device: ${dev}`, scanned_at: log.timestamp || log.createdAt, method: 'migrated' });
        n++;
      }
    }
  }
  // v1 vehicle-access-logs → movements
  const vlogs = await db('api::vehicle-access-log.vehicle-access-log').find({ populate: { vehicle: true, driver: true }, limit: 100000 });
  for (const l of vlogs) {
    const ap = await apFor(l.location);
    await db(U.movement).create({ asset: l.vehicle?.id || null, person: l.driver?.id || null, direction: l.direction || 'IN', access_point: ap.id, branch: hq.id, guard: 'v1', result: 'ok', scanned_at: l.createdAt, method: 'migrated' });
    n++;
  }
  // v1 anomalies → investigation cases
  const sev = { critical: 'critical', warning: 'medium', info: 'low' };
  const anomalies = await db('api::anomaly.anomaly').find({ limit: 100000 });
  for (const a of anomalies) {
    await L.openCase(null, { type: 'manual', severity: sev[a.severity] || 'medium', title: `[v1] ${a.type || 'Anomaly'}: ${String(a.description || '').slice(0, 180)}`, description: [a.description, a.location && `Location: ${a.location}`, a.assigned_to && `Assigned: ${a.assigned_to}`].filter(Boolean).join('\n'), status: a.investigationStatus === 'resolved' || a.reviewed ? 'closed' : a.investigationStatus === 'in_progress' ? 'investigating' : 'new', branch: hq.id });
  }
  // v1 entrance sessions → visits
  const sessions = await db('api::entrance-session.entrance-session').find({ populate: { guest: true, staff: true }, limit: 100000 });
  const status = { pending_reception: 'waiting', checked_in: 'in_building', checked_out: 'checked_out' };
  for (const e of sessions) {
    if (e.visitor_type !== 'guest' || !e.guest) continue;
    const ap = e.entrance ? await apFor(e.entrance) : null;
    await db(U.visit).create({ visitor: e.guest.id, purpose: e.purpose || null, notes: [e.visiting_person && `Host (v1 text): ${e.visiting_person}`, e.department && `Department: ${e.department}`, e.additional_notes].filter(Boolean).join('\n') || null, branch: hq.id, access_point_in: ap?.id || null, status: status[e.session_status] || 'checked_out', arrived_at: e.check_in_time || e.createdAt, checked_in_at: e.check_in_time, checked_out_at: e.check_out_time, registered_by: e.registered_by || 'v1' });
  }
  strapi.log.info(`[v2] v1 migration: ${vlogs.length} vehicle logs, ${anomalies.length} anomalies, ${sessions.length} visitor sessions`);
  await db(U.audit).create({ user: 'system', action: 'v1_migration', entity: 'movement', entity_id: String(n), at: new Date() });
  strapi.log.info(`[v2] v1 migration: ${n} movements created`);
}
module.exports.ROLES = ROLES;
