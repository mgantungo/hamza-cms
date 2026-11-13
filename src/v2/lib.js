'use strict';
/**
 * Asset Tracker v2 – shared backend helpers.
 * Everything under /api/v2 goes through these: auth, RBAC, scoping, audit, numbering.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const MODULES = ['gate', 'reception', 'assets', 'noncompany', 'staff', 'store', 'requisitions', 'imports', 'labels', 'reports', 'investigations', 'admin', 'audit'];
const ACTIONS = ['view', 'create', 'edit', 'approve', 'delete', 'export'];

const U = {
  branch: 'api::branch.branch', ap: 'api::access-point.access-point', terminal: 'api::terminal.terminal',
  role: 'api::app-role.app-role', user: 'api::app-user.app-user', dept: 'api::department.department',
  office: 'api::office.office', category: 'api::asset-category.asset-category', staff: 'api::staff.staff',
  asset: 'api::company-asset.company-asset', history: 'api::asset-history.asset-history',
  movement: 'api::movement.movement', visit: 'api::visit.visit', appointment: 'api::appointment.appointment',
  badge: 'api::visitor-badge.visitor-badge', guest: 'api::guest.guest', case: 'api::investigation.investigation',
  store: 'api::store.store', item: 'api::store-item.store-item', level: 'api::stock-level.stock-level',
  tx: 'api::stock-transaction.stock-transaction', req: 'api::requisition.requisition',
  rule: 'api::approval-rule.approval-rule', audit: 'api::audit-log.audit-log', notif: 'api::notification.notification',
  shift: 'api::shift.shift', accessLog: 'api::access-log.access-log',
};

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const SECRET = () => env('V2_JWT_SECRET', env('JWT_SECRET', 'change-me'));
const TOKEN_TTL = () => env('V2_JWT_TTL', '12h');

// ---------------------------------------------------------------- db wrapper
function newDocumentId() {
  // 24-char lowercase id like Strapi's cuid2 document ids
  return crypto.randomBytes(18).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(24, '0').slice(0, 24);
}
function db(uid) {
  const q = strapi.db.query(uid);
  return {
    find: (opts = {}) => q.findMany(opts),
    one: (opts = {}) => q.findOne(opts),
    byId: (id, populate) => q.findOne({ where: { id }, populate }),
    count: (where = {}) => q.count({ where }),
    create: (data, populate) => q.create({ data: { documentId: newDocumentId(), ...data }, populate }),
    update: (id, data, populate) => q.update({ where: { id }, data, populate }),
    remove: (id) => q.delete({ where: { id } }),
    raw: q,
  };
}

// ---------------------------------------------------------------- auth
const hash = (pw) => bcrypt.hashSync(String(pw), 10);
const checkPw = (pw, h) => !!h && bcrypt.compareSync(String(pw || ''), h);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = (user) => jwt.sign({ uid: user.id, u: user.username }, SECRET(), { expiresIn: TOKEN_TTL() });

const userCache = new Map();
async function loadUser(id, fresh = false) {
  const c = userCache.get(id);
  if (!fresh && c && Date.now() - c.at < 30000) return c.user;
  const u = await db(U.user).one({ where: { id }, populate: { roles: true, branches: true, access_points: { populate: { branch: true } }, staff: { populate: { dept: true, branch: true } } } });
  if (!u) return null;
  const user = shapeUser(u);
  userCache.set(id, { at: Date.now(), user });
  return user;
}
function clearUserCache() { userCache.clear(); }

function shapeUser(u) {
  const perms = {};
  let all = false;
  let limit = 0;
  for (const r of u.roles || []) {
    if (r.scope === 'all') all = true;
    if (r.approval_limit && Number(r.approval_limit) > limit) limit = Number(r.approval_limit);
    const p = r.permissions || {};
    if (p['*']) { MODULES.forEach((m) => { perms[m] = new Set(ACTIONS); }); continue; }
    for (const [m, acts] of Object.entries(p)) {
      perms[m] = perms[m] || new Set();
      (acts || []).forEach((a) => perms[m].add(a));
    }
  }
  const branchIds = new Set((u.branches || []).map((x) => x.id));
  (u.access_points || []).forEach((ap) => ap.branch && branchIds.add(ap.branch.id));
  if (u.staff?.branch) branchIds.add(u.staff.branch.id);
  return {
    id: u.id, username: u.username, full_name: u.full_name || u.username, email: u.email, active: u.active,
    roles: (u.roles || []).map((r) => r.name), roleScopes: (u.roles || []).map((r) => r.scope),
    allBranches: all, branchIds: [...branchIds], accessPointIds: (u.access_points || []).map((x) => x.id),
    staff: u.staff ? { id: u.staff.id, staff_id: u.staff.staff_id, staff_name: u.staff.staff_name, dept: u.staff.dept?.id || null, deptName: u.staff.dept?.name || u.staff.department || null } : null,
    approvalLimit: limit,
    permissions: Object.fromEntries(Object.entries(perms).map(([k, v]) => [k, [...v]])),
  };
}

function can(user, module, action = 'view') {
  if (!user) return false;
  const p = user.permissions[module];
  return !!p && p.includes(action);
}
function hasRole(user, name) { return !!user && user.roles.includes(name); }

async function userFromCtx(ctx) {
  const h = ctx.request.header.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return null;
  try {
    const p = jwt.verify(tok, SECRET());
    const u = await loadUser(p.uid);
    return u && u.active !== false ? u : null;
  } catch { return null; }
}

/** Returns a where-fragment limiting rows to the user's branches, or {} when unrestricted. */
function branchWhere(user, field = 'branch') {
  if (!user || user.allBranches) return {};
  if (!user.branchIds.length) return { [field]: { id: { $in: [-1] } } };
  return { $or: [{ [field]: { id: { $in: user.branchIds } } }, { [field]: { id: { $null: true } } }] };
}

// ---------------------------------------------------------------- terminals
async function terminalFromToken(token) {
  if (!token) return null;
  const t = await db(U.terminal).one({ where: { token_hash: sha256(token), revoked: false }, populate: { access_point: { populate: { branch: true } } } });
  return t || null;
}
async function terminalFromCtx(ctx) {
  const tok = ctx.request.header['x-terminal-token'];
  return terminalFromToken(tok);
}

// ---------------------------------------------------------------- misc
async function audit(ctx, action, entity, entityId, before, after) {
  try {
    await db(U.audit).create({ user: ctx?.state?.appUser?.username || 'system', action, entity, entity_id: entityId != null ? String(entityId) : null, before: before || null, after: after || null, at: new Date(), ip: ctx?.request?.ip || null });
  } catch (e) { strapi.log.warn('audit failed: ' + e.message); }
}

async function notify(userIds, title, body, link) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  for (const id of ids) {
    try { await db(U.notif).create({ user: id, title, body, link, read: false, at: new Date() }); } catch (e) { strapi.log.warn(e.message); }
  }
  const hook = env('SMS_WEBHOOK_URL');
  if (hook && ids.length) {
    // optional SMS/email bridge: POST JSON to your gateway
    try {
      const users = await db(U.user).find({ where: { id: { $in: ids } } });
      await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: users.map((u) => ({ phone: u.phone, email: u.email })), title, body }) });
    } catch (e) { strapi.log.warn('sms hook failed: ' + e.message); }
  }
}
async function usersWithRole(roleName, filter = {}) {
  const users = await db(U.user).find({ where: { active: true, roles: { name: roleName } }, populate: { branches: true, staff: { populate: { dept: true } }, access_points: { populate: { branch: true } } } });
  return users.filter((u) => {
    if (filter.dept && (u.staff?.dept?.id !== filter.dept)) return false;
    if (filter.branch) {
      const b = new Set((u.branches || []).map((x) => x.id));
      (u.access_points || []).forEach((a) => a.branch && b.add(a.branch.id));
      if (b.size && !b.has(filter.branch)) return false;
    }
    return true;
  });
}

async function nextNumber(uid, field, prefix, pad = 4) {
  const rows = await db(uid).find({ where: { [field]: { $startsWith: prefix } }, select: [field], orderBy: { [field]: 'desc' }, limit: 1 });
  let n = 0;
  if (rows.length) { const m = String(rows[0][field]).slice(prefix.length).match(/\d+/); n = m ? parseInt(m[0], 10) : 0; }
  return prefix + String(n + 1).padStart(pad, '0');
}

async function nextTags(prefix, count, pad = 6) {
  const rows = await db(U.asset).find({ where: { tag_number: { $startsWith: prefix } }, select: ['tag_number'] });
  let max = 0;
  for (const r of rows) {
    const rest = String(r.tag_number).slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, parseInt(rest, 10));
  }
  return Array.from({ length: count }, (_, i) => prefix + String(max + 1 + i).padStart(pad, '0'));
}
function tagPrefixFor(ownership, category) {
  const base = env('ASSET_TAG_PREFIX', 'VG-');
  if (ownership === 'personal') return 'P-';
  if (ownership === 'visitor') return 'VS-';
  if (ownership === 'third_party') return 'TP-';
  return base + (category?.tag_prefix ? category.tag_prefix + '-' : '');
}

const SEVERITY_DUE_HOURS = { critical: 24, high: 72, medium: 168, low: 336 };
async function openCase(ctx, data) {
  const number = await nextNumber(U.case, 'number', 'CASE-');
  const due = new Date(Date.now() + (SEVERITY_DUE_HOURS[data.severity || 'medium'] || 168) * 3600e3);
  const c = await db(U.case).create({ number, status: 'new', due_at: due, notes: [], evidence: [], write_off_status: 'none', opened_by: ctx?.state?.appUser?.username || 'system', ...data });
  // tell security supervisors in that branch
  const sups = await usersWithRole('Security Supervisor', { branch: data.branch || null });
  await notify(sups.map((u) => u.id), `${number}: ${data.title || data.type}`, data.description || '', `/security/investigations/${c.id}`);
  return c;
}
async function addCaseNote(caseId, by, text, kind = 'note') {
  const c = await db(U.case).byId(caseId);
  if (!c) return null;
  const notes = Array.isArray(c.notes) ? c.notes : [];
  notes.push({ at: new Date().toISOString(), by, text, kind });
  return db(U.case).update(caseId, { notes });
}

async function history(ctx, assetId, action_type, extra = {}) {
  return db(U.history).create({ company_asset: assetId, action_type, performed_by: ctx?.state?.appUser?.username || 'system', user: ctx?.state?.appUser?.username || 'system', event_date: new Date(), ...extra });
}

function bad(ctx, msg, status = 400) { ctx.status = status; ctx.body = { error: { status, message: msg } }; return ctx.body; }
const idOf = (v) => (v && typeof v === 'object' ? v.id : v);
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

module.exports = {
  MODULES, ACTIONS, U, env, db, hash, checkPw, sha256, sign, loadUser, shapeUser, clearUserCache, can, hasRole,
  userFromCtx, branchWhere, terminalFromToken, terminalFromCtx, audit, notify, usersWithRole, nextNumber, nextTags,
  tagPrefixFor, openCase, addCaseNote, history, bad, idOf, num, newDocumentId,
};
