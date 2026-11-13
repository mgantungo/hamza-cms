'use strict';
/**
 * Generic, permission-checked CRUD for reference data and simple records.
 * GET    /api/v2/r/:resource            list  (?q= &filters[..] &page &pageSize &sort=field:dir)
 * GET    /api/v2/r/:resource/:id        one
 * POST   /api/v2/r/:resource            create
 * PUT    /api/v2/r/:resource/:id        update
 * DELETE /api/v2/r/:resource/:id        delete
 */
const L = require('../lib');
const { U, db } = L;

const ANY = '*';
const R = {
  branches: { uid: U.branch, view: ANY, edit: 'admin', search: ['name', 'code'] },
  'access-points': { uid: U.ap, view: ANY, edit: 'admin', search: ['name'], populate: { branch: true }, scope: 'branch' },
  terminals: { uid: U.terminal, view: 'admin', edit: 'admin', noCreate: true, search: ['name', 'last_user'], populate: { access_point: { populate: { branch: true } } } },
  roles: { uid: U.role, view: 'admin', edit: 'admin', search: ['name'], after: () => L.clearUserCache() },
  users: { uid: U.user, view: 'admin', edit: 'admin', search: ['username', 'full_name', 'email'], populate: { roles: true, branches: true, access_points: true, staff: true }, before: userBefore, after: () => L.clearUserCache() },
  departments: { uid: U.dept, view: ANY, edit: 'staff', search: ['name', 'code'] },
  offices: { uid: U.office, view: ANY, edit: 'assets', search: ['name', 'floor'], populate: { branch: true }, scope: 'branch' },
  categories: { uid: U.category, view: ANY, edit: 'assets', search: ['name', 'tag_prefix'] },
  staff: { uid: U.staff, view: 'staff', viewAlso: ['gate', 'reception', 'store', 'requisitions', 'assets', 'investigations'], edit: 'staff', search: ['staff_name', 'staff_id', 'card_number', 'email', 'position'], populate: { dept: true, branch: true }, scope: 'branch' },
  assets: { uid: U.asset, view: 'assets', viewAlso: ['noncompany', 'gate', 'investigations', 'labels', 'reports'], edit: 'assets', noCreate: true, search: ['tag_number', 'asset_name', 'serial_number', 'make', 'model', 'owner_name'], populate: { assigned_to: true, category_ref: true, branch: true, office: true, last_access_point: true, visit: { populate: { visitor: true } } }, scope: 'branch' },
  stores: { uid: U.store, view: ANY, edit: 'store', search: ['name'], populate: { branch: true }, scope: 'branch' },
  'store-items': { uid: U.item, view: 'store', viewAlso: ['requisitions'], edit: 'store', search: ['code', 'name', 'category'] },
  'stock-levels': { uid: U.level, view: 'store', viewAlso: ['requisitions'], edit: null, populate: { item: true, store: true } },
  transactions: { uid: U.tx, view: 'store', edit: null, search: ['issued_by', 'supplier', 'delivery_note'], populate: { item: true, store: true, taker: true, department: true, linked_asset: true, requisition: true } },
  appointments: { uid: U.appointment, view: 'reception', edit: 'reception', noCreate: true, search: ['visitor_name', 'organisation', 'phone', 'invite_code'], populate: { host: true, branch: true }, scope: 'branch' },
  badges: { uid: U.badge, view: 'reception', viewAlso: ['gate'], edit: 'reception', search: ['number'], populate: { branch: true }, scope: 'branch' },
  visits: { uid: U.visit, view: 'reception', viewAlso: ['gate', 'reports'], edit: null, search: [], populate: { visitor: true, host: true, badge: true, access_point_in: true, access_point_out: true }, scope: 'branch' },
  guests: { uid: U.guest, view: 'reception', viewAlso: ['gate'], edit: 'reception', search: ['guest_name', 'nin', 'phone', 'organisation'] },
  'approval-rules': { uid: U.rule, view: 'admin', edit: 'admin', search: ['name', 'approver_role'], populate: { department: true } },
  investigations: { uid: U.case, view: 'investigations', edit: null, search: ['number', 'title', 'description'], populate: { asset: true, staff: true, investigator: true, branch: true, access_point: true }, scope: 'branch' },
  movements: { uid: U.movement, view: 'gate', viewAlso: ['reports', 'investigations'], edit: null, search: ['guard', 'reason'], populate: { asset: true, person: true, access_point: true, visit: { populate: { visitor: true } } }, scope: 'branch' },
  audit: { uid: U.audit, view: 'audit', edit: null, search: ['user', 'action', 'entity', 'entity_id'] },
  passcards: { uid: 'api::vehicle-passcard.vehicle-passcard', view: 'gate', viewAlso: ['reception', 'reports'], edit: 'gate', search: ['passcard_number', 'notes'], populate: { branch: true } },
  'guest-vehicles': { uid: 'api::guest-vehicle-session.guest-vehicle-session', view: 'gate', viewAlso: ['reception', 'reports'], edit: null, search: ['plate_number', 'visitor_name'], populate: { passcard: true, access_point: true } },
  shifts: { uid: U.shift, view: 'gate', viewAlso: ['reports'], edit: null, search: ['guard_name', 'entrance'], populate: { access_point: true, user: true } },
};

const PRIVATE = ['password_hash', 'pin_hash', 'token_hash'];
function clean(row) {
  if (!row || typeof row !== 'object') return row;
  if (Array.isArray(row)) return row.map(clean);
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (PRIVATE.includes(k)) continue;
    o[k] = v && typeof v === 'object' && !(v instanceof Date) ? clean(v) : v;
  }
  return o;
}

async function userBefore(data, existing) {
  if (data.password) { data.password_hash = L.hash(data.password); }
  if (data.pin) { data.pin_hash = L.hash(data.pin); }
  delete data.password; delete data.pin;
  if (!existing && !data.password_hash) throw Object.assign(new Error('A password is required for a new user'), { status: 400 });
  return data;
}

function canView(user, def) {
  if (def.view === ANY) return true;
  if (L.can(user, def.view, 'view')) return true;
  return (def.viewAlso || []).some((m) => L.can(user, m, 'view'));
}
function moduleFor(def, data) {
  // personal / visitor / third-party items belong to the non-company module
  if (def.uid === U.asset && data && data.ownership && data.ownership !== 'company') return 'noncompany';
  return def.edit;
}

const OPS = ['$eq', '$eqi', '$ne', '$in', '$notIn', '$lt', '$lte', '$gt', '$gte', '$contains', '$containsi', '$null', '$notNull', '$startsWith'];
function buildWhere(uid, filters) {
  const attrs = strapi.getModel(uid).attributes;
  const where = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (k === '$or' && Array.isArray(v)) { where.$or = v.map((x) => buildWhere(uid, x)); continue; }
    const a = k === 'id' ? { type: 'integer' } : attrs[k];
    if (!a) throw Object.assign(new Error(`Unknown filter field "${k}"`), { status: 400 });
    const isRel = a.type === 'relation';
    const conv = (val) => (val === 'null' ? null : val === 'true' ? true : val === 'false' ? false : val);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      for (const [op, val] of Object.entries(v)) {
        if (OPS.includes(op)) o[op] = Array.isArray(val) ? val.map(conv) : conv(val);
        else if (isRel && op === 'id') o.$eq = conv(val);
      }
      where[k] = isRel ? { id: o } : o;
    } else if (Array.isArray(v)) {
      where[k] = isRel ? { id: { $in: v.map(conv) } } : { $in: v.map(conv) };
    } else {
      where[k] = isRel ? { id: conv(v) } : conv(v);
    }
  }
  return where;
}

function relData(uid, body) {
  // accept {branch: 3} / {branch: {id: 3}} / {roles: [1,2]} — keep only real attributes
  const attrs = strapi.getModel(uid).attributes;
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!attrs[k] && !['password', 'pin'].includes(k)) continue;
    if (['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt'].includes(k)) continue;
    const a = attrs[k];
    if (a && a.type === 'relation') {
      if (Array.isArray(v)) out[k] = v.map(L.idOf).filter((x) => x != null);
      else out[k] = v === '' || v === undefined ? null : L.idOf(v);
    } else if (a && ['integer', 'decimal', 'float', 'biginteger'].includes(a.type)) {
      out[k] = L.num(v);
    } else if (a && ['date', 'datetime'].includes(a.type)) {
      out[k] = v === '' ? null : v;
    } else out[k] = v;
  }
  return out;
}

function getDef(ctx) {
  const def = R[ctx.params.resource];
  if (!def) { L.bad(ctx, 'Unknown resource', 404); return null; }
  return def;
}

module.exports = {
  R, clean, buildWhere, relData,

  async list(ctx) {
    const def = getDef(ctx); if (!def) return ctx.body;
    const user = ctx.state.appUser;
    if (!canView(user, def)) return L.bad(ctx, 'Not allowed', 403);
    const { q, filters, page = 1, pageSize = 25, sort } = ctx.query;
    const where = { $and: [buildWhere(def.uid, filters)] };
    if (q && def.search?.length) where.$and.push({ $or: def.search.map((f) => ({ [f]: { $containsi: q } })) });
    if (def.scope && !user.allBranches) where.$and.push(L.branchWhere(user, def.scope));
    // non-company items are only listed for people with that module
    if (def.uid === U.asset && !L.can(user, 'noncompany', 'view') && !L.can(user, 'investigations', 'view')) where.$and.push({ ownership: 'company' });
    const size = Math.min(Number(pageSize) || 25, 500);
    let orderBy = { id: 'desc' };
    if (sort) { const [f, d] = String(sort).split(':'); if (strapi.getModel(def.uid).attributes[f] || f === 'id' || f === 'createdAt') orderBy = { [f]: d === 'asc' ? 'asc' : 'desc' }; }
    const [rows, total] = await Promise.all([
      db(def.uid).find({ where, populate: def.populate, orderBy, limit: size, offset: (Number(page) - 1) * size }),
      db(def.uid).raw.count({ where }),
    ]);
    return { data: clean(rows), meta: { page: Number(page), pageSize: size, total, pageCount: Math.ceil(total / size) } };
  },

  async one(ctx) {
    const def = getDef(ctx); if (!def) return ctx.body;
    if (!canView(ctx.state.appUser, def)) return L.bad(ctx, 'Not allowed', 403);
    const row = await db(def.uid).byId(ctx.params.id, def.populate);
    if (!row) return L.bad(ctx, 'Not found', 404);
    return { data: clean(row) };
  },

  async create(ctx) {
    const def = getDef(ctx); if (!def) return ctx.body;
    if (!def.edit || def.noCreate) return L.bad(ctx, 'Create this through its own screen', 405);
    let data = relData(def.uid, ctx.request.body?.data || ctx.request.body);
    if (!L.can(ctx.state.appUser, moduleFor(def, data), 'create')) return L.bad(ctx, 'Not allowed', 403);
    try { if (def.before) data = await def.before(data, null); } catch (e) { return L.bad(ctx, e.message, e.status || 400); }
    const row = await db(def.uid).create(data, def.populate);
    if (def.after) await def.after(row);
    await L.audit(ctx, 'create', ctx.params.resource, row.id, null, clean(data));
    return { data: clean(row) };
  },

  async update(ctx) {
    const def = getDef(ctx); if (!def) return ctx.body;
    const existing = await db(def.uid).byId(ctx.params.id);
    if (!existing) return L.bad(ctx, 'Not found', 404);
    if (!def.edit) return L.bad(ctx, 'Read-only', 405);
    if (!L.can(ctx.state.appUser, moduleFor(def, existing), 'edit')) return L.bad(ctx, 'Not allowed', 403);
    let data = relData(def.uid, ctx.request.body?.data || ctx.request.body);
    try { if (def.before) data = await def.before(data, existing); } catch (e) { return L.bad(ctx, e.message, e.status || 400); }
    if (def.uid === U.role && existing.builtin && data.name && data.name !== existing.name) return L.bad(ctx, 'Built-in roles cannot be renamed; duplicate it instead');
    if (def.uid === U.staff && data.status === 'left' && existing.status !== 'left') {
      // exit clearance: nothing may still be held
      const held = await db(U.asset).count({ assigned_to: { id: existing.id }, ownership: 'company', asset_status: { $ne: 'decommissioned' } });
      const loans = await db(U.tx).count({ taker: { id: existing.id }, type: 'lend', loan_status: 'open' });
      if (held || loans) return L.bad(ctx, `Not cleared: still holds ${held} asset(s) and ${loans} store loan(s). Return or transfer them first.`, 409);
    }
    if (def.uid === U.asset && data.serial_number) {
      const cat = await db(U.category).byId(data.category_ref || existing.category_ref?.id || (await db(U.asset).byId(existing.id, { category_ref: true })).category_ref?.id);
      if (cat?.is_vehicle) data.serial_number = String(data.serial_number).replace(/\s+/g, '').toUpperCase();
    }
    const row = await db(def.uid).update(existing.id, data, def.populate);
    if (def.after) await def.after(row);
    if (def.uid === U.asset) await L.history(ctx, row.id, 'update', { notes: 'Edited', extra: { changed: Object.keys(data) } });
    await L.audit(ctx, 'update', ctx.params.resource, row.id, clean(existing), clean(data));
    return { data: clean(row) };
  },

  async remove(ctx) {
    const def = getDef(ctx); if (!def) return ctx.body;
    const existing = await db(def.uid).byId(ctx.params.id);
    if (!existing) return L.bad(ctx, 'Not found', 404);
    if (!def.edit || !L.can(ctx.state.appUser, moduleFor(def, existing), 'delete')) return L.bad(ctx, 'Not allowed', 403);
    if (def.uid === U.role && existing.builtin) return L.bad(ctx, 'Built-in roles cannot be deleted');
    await db(def.uid).remove(existing.id);
    if (def.after) await def.after(existing);
    await L.audit(ctx, 'delete', ctx.params.resource, existing.id, clean(existing), null);
    return { ok: true };
  },
};
