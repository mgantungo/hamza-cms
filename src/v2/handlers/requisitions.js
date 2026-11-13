'use strict';
const L = require('../lib');
const { U, db } = L;
const { clean } = require('./resources');
const store = require('./store');

const POP = { requester: { populate: { dept: true } }, requester_user: true, department: true, store: true, branch: true };
const OPEN_STEP = ['submitted', 'manager_approved', 'returned_to_requester'];

async function buildSteps(r, lines) {
  const steps = [{ role: 'Manager', dept: r.department, status: 'pending' }];
  const rules = await db(U.rule).find({ where: { active: true }, populate: { department: true }, orderBy: { order: 'asc' } });
  const cats = new Set(lines.map((l) => l.category).filter(Boolean));
  for (const rule of rules) {
    let hit = false;
    if (rule.applies_to === 'all') hit = true;
    if (rule.applies_to === 'department') hit = rule.department?.id === r.department;
    if (rule.applies_to === 'category') hit = cats.has(rule.category);
    if (rule.applies_to === 'value_above') hit = Number(r.total_value || 0) > Number(rule.value_above || 0);
    if (rule.applies_to === 'type') hit = rule.req_type === r.type;
    if (hit && rule.approver_role) steps.push({ role: rule.approver_role, rule: rule.name, status: 'pending' });
  }
  const sm = await db(U.role).one({ where: { name: 'Store Manager' } });
  const limit = Number(sm?.approval_limit || 0);
  if (r.type !== 'new_asset' && limit && Number(r.total_value || 0) > limit) steps.push({ role: 'Branch Admin', rule: 'Above Store Manager limit', status: 'pending' });
  steps.push({ role: r.type === 'new_asset' ? 'Asset Officer' : 'Store Manager', final: true, status: 'pending' });
  const seen = new Set();
  return steps.filter((s) => (seen.has(s.role) ? false : seen.add(s.role)));
}

function canAct(user, r, step) {
  if (!step) return false;
  if (L.hasRole(user, 'Super Admin')) return true;
  if (!L.hasRole(user, step.role)) return false;
  if (step.role === 'Manager') return user.staff?.dept && user.staff.dept === (r.department?.id ?? r.department);
  if (!user.allBranches && r.branch && !user.branchIds.includes(r.branch.id ?? r.branch)) return false;
  return true;
}
function hist(r, by, text) { const h = Array.isArray(r.history) ? r.history : []; h.push({ at: new Date().toISOString(), by, text }); return h; }

async function linesFrom(raw) {
  const lines = [];
  let total = 0;
  for (const l of raw || []) {
    if (!l || !(Number(l.qty) > 0)) continue;
    if (l.itemId) {
      const it = await db(U.item).byId(l.itemId);
      if (!it) continue;
      const cost = Number(it.unit_cost || 0);
      total += cost * Number(l.qty);
      lines.push({ itemId: it.id, code: it.code, name: it.name, unit: it.unit, kind: it.kind, category: it.category, unit_cost: cost, qty_requested: Number(l.qty), qty_approved: Number(l.qty), qty_issued: 0, note: l.note || null });
    } else if (l.name) {
      lines.push({ itemId: null, name: l.name, category: l.category || null, qty_requested: Number(l.qty), qty_approved: Number(l.qty), qty_issued: 0, note: l.note || null });
    }
  }
  return { lines, total };
}

module.exports = {
  async list(ctx) {
    const user = ctx.state.appUser;
    const { scope = 'mine', status } = ctx.query;
    const where = { $and: [] };
    if (scope === 'mine' || !L.can(user, 'requisitions', 'approve')) where.$and.push({ requester_user: { id: user.id } });
    else if (L.hasRole(user, 'Manager') && !L.hasRole(user, 'Store Manager') && !L.hasRole(user, 'Branch Admin') && !user.allBranches) where.$and.push({ department: { id: user.staff?.dept || -1 } });
    else if (!user.allBranches) where.$and.push(L.branchWhere(user, 'branch'));
    if (status) where.$and.push({ status });
    const rows = await db(U.req).find({ where, populate: POP, orderBy: { id: 'desc' }, limit: 200 });
    return { data: clean(rows) };
  },

  async inbox(ctx) {
    const user = ctx.state.appUser;
    const rows = await db(U.req).find({ where: { status: { $in: ['submitted', 'manager_approved', 'approved', 'partly_issued'] } }, populate: POP, orderBy: { submitted_at: 'asc' }, limit: 300 });
    const mine = rows.filter((r) => {
      if (['approved', 'partly_issued'].includes(r.status)) {
        const role = r.type === 'new_asset' ? 'Asset Officer' : 'Store Manager';
        return canAct(user, r, { role }) || (L.hasRole(user, 'Storekeeper') && r.type !== 'new_asset');
      }
      return canAct(user, r, (r.steps || [])[r.current_step || 0]);
    });
    return { data: clean(mine) };
  },

  async get(ctx) {
    const r = await db(U.req).byId(ctx.params.id, POP);
    if (!r) return L.bad(ctx, 'Not found', 404);
    const user = ctx.state.appUser;
    const own = r.requester_user?.id === user.id;
    if (!own && !L.can(user, 'requisitions', 'approve') && !L.can(user, 'store', 'view')) return L.bad(ctx, 'Not allowed', 403);
    const step = (r.steps || [])[r.current_step || 0];
    const txs = await db(U.tx).find({ where: { requisition: { id: r.id } }, populate: { item: true, taker: true }, orderBy: { id: 'asc' } });
    const stock = {};
    if (r.store) {
      const lv = await db(U.level).find({ where: { store: { id: r.store.id } }, populate: { item: true } });
      lv.forEach((l) => { if (l.item) stock[l.item.id] = Number(l.qty || 0); });
    }
    return { data: clean(r), canDecide: OPEN_STEP.includes(r.status) && r.status !== 'returned_to_requester' && canAct(user, r, step), canIssue: ['approved', 'partly_issued'].includes(r.status) && (canAct(user, r, { role: r.type === 'new_asset' ? 'Asset Officer' : 'Store Manager' }) || L.hasRole(user, 'Storekeeper')), canConfirm: own && r.status === 'issued', isOwner: own, stock, transactions: clean(txs) };
  },

  async save(ctx) {
    const user = ctx.state.appUser;
    const b = ctx.request.body || {};
    if (!user.staff) return L.bad(ctx, 'Your login is not linked to a staff record, so you cannot raise requisitions', 403);
    const existing = ctx.params.id ? await db(U.req).byId(ctx.params.id, { requester_user: true }) : null;
    if (existing && (existing.requester_user?.id !== user.id || !['draft', 'returned_to_requester'].includes(existing.status))) return L.bad(ctx, 'This requisition can no longer be edited', 409);
    const { lines, total } = await linesFrom(b.lines);
    if (!lines.length) return L.bad(ctx, 'Add at least one item with a quantity');
    const storeRow = b.storeId ? await db(U.store).byId(b.storeId, { branch: true }) : null;
    if (b.type !== 'new_asset' && !storeRow) return L.bad(ctx, 'Choose the store');
    if (b.type === 'borrow' && !b.return_by) return L.bad(ctx, 'Give a return-by date for borrowed items');
    const data = { type: b.type || 'consumable', requester: user.staff.id, requester_user: user.id, department: L.idOf(b.departmentId) || user.staff.dept, store: storeRow?.id || null, branch: storeRow?.branch?.id || user.branchIds[0] || null, needed_by: b.needed_by || null, return_by: b.return_by || null, purpose: b.purpose || null, lines, total_value: total };
    let r;
    if (existing) r = await db(U.req).update(existing.id, data);
    else r = await db(U.req).create({ ...data, number: await L.nextNumber(U.req, 'number', `REQ-${new Date().getFullYear()}-`), status: 'draft', history: [{ at: new Date().toISOString(), by: user.username, text: 'Created' }] });
    if (b.submit) {
      const steps = await buildSteps({ ...data, department: data.department }, lines);
      let current = 0;
      const h = hist(r, user.username, 'Submitted');
      // a manager raising for their own department approves step 1 implicitly
      if (L.hasRole(user, 'Manager') && user.staff.dept === data.department) { steps[0].status = 'approved'; steps[0].by = user.username; steps[0].at = new Date().toISOString(); steps[0].comment = 'Raised by the department manager'; current = 1; }
      r = await db(U.req).update(r.id, { steps, current_step: current, status: current ? 'manager_approved' : 'submitted', submitted_at: new Date(), history: h });
      await notifyStep(r, steps[current]);
    }
    await L.audit(ctx, b.submit ? 'submit' : 'save', 'requisition', r.id);
    ctx.params.id = r.id;
    return module.exports.get(ctx);
  },

  async decide(ctx) {
    const user = ctx.state.appUser;
    const { decision, comment, approvedQty = {} } = ctx.request.body || {};
    const r = await db(U.req).byId(ctx.params.id, POP);
    if (!r) return L.bad(ctx, 'Not found', 404);
    const steps = r.steps || [];
    const i = r.current_step || 0;
    const step = steps[i];
    if (!['submitted', 'manager_approved'].includes(r.status) || !canAct(user, r, step)) return L.bad(ctx, 'This requisition is not waiting for you', 403);
    if (['reject', 'return'].includes(decision) && !comment) return L.bad(ctx, 'A comment is required');
    const lines = (r.lines || []).map((l, idx) => (approvedQty[idx] !== undefined ? { ...l, qty_approved: Math.max(0, Math.min(Number(approvedQty[idx]), l.qty_requested)) } : l));
    steps[i] = { ...step, status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'returned', by: user.username, byName: user.full_name, at: new Date().toISOString(), comment: comment || null };
    const changed = lines.filter((l, idx) => l.qty_approved !== (r.lines[idx] || {}).qty_approved).map((l) => `${l.name} ${l.qty_requested}→${l.qty_approved}`);
    let status = r.status; let current = i;
    if (decision === 'approve') {
      current = i + 1;
      status = current >= steps.length ? 'approved' : 'manager_approved';
    } else if (decision === 'reject') status = 'rejected';
    else { status = 'returned_to_requester'; current = 0; steps.forEach((s) => { s.status = 'pending'; delete s.by; delete s.at; }); }
    const text = `${decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Rejected' : 'Returned for changes'} by ${user.full_name} (${step.role})${changed.length ? `; changed ${changed.join(', ')}` : ''}${comment ? `: ${comment}` : ''}`;
    const row = await db(U.req).update(r.id, { steps, current_step: current, status, lines, history: hist(r, user.username, text) });
    if (decision === 'approve' && current < steps.length) await notifyStep(row, steps[current]);
    if (status === 'approved') await notifyStep(row, { role: r.type === 'new_asset' ? 'Asset Officer' : 'Store Manager' }, 'ready to issue');
    if (r.requester_user) await L.notify([r.requester_user.id], `${r.number}: ${status.replace(/_/g, ' ')}`, text, `/requisitions/${r.id}`);
    await L.audit(ctx, decision, 'requisition', r.id, null, { step: step.role });
    return module.exports.get(ctx);
  },

  /** lines: [{ idx, qty }] — issues or lends stock from the requisition's store. For new_asset: assetIds to assign. */
  async issue(ctx) {
    const user = ctx.state.appUser;
    const r = await db(U.req).byId(ctx.params.id, POP);
    if (!r || !['approved', 'partly_issued'].includes(r.status)) return L.bad(ctx, 'Not ready to issue', 409);
    const lines = r.lines || [];
    if (r.type === 'new_asset') {
      const ids = (ctx.request.body?.assetIds || []).map(Number);
      if (!ids.length) return L.bad(ctx, 'Pick the assets to hand over');
      ctx.request.body = { action: 'assign', ids, staffId: r.requester?.id, reason: `Requisition ${r.number}` };
      await require('./assets').action(ctx);
      if (ctx.status >= 400) return ctx.body;
      ctx.status = 200;
      lines.forEach((l) => { l.qty_issued = l.qty_approved; });
    } else {
      const req = (ctx.request.body?.lines || []).filter((x) => Number(x.qty) > 0);
      if (!req.length) return L.bad(ctx, 'Enter quantities to issue');
      const post = [];
      for (const x of req) {
        const l = lines[x.idx];
        if (!l || !l.itemId) continue;
        const remaining = l.qty_approved - (l.qty_issued || 0);
        if (Number(x.qty) > remaining) return L.bad(ctx, `${l.name}: only ${remaining} left to issue`);
        post.push({ itemId: l.itemId, qty: Number(x.qty), idx: x.idx });
      }
      try {
        await store.post(ctx, { type: r.type === 'borrow' ? 'lend' : 'issue', storeId: r.store?.id, takerId: r.requester?.id, departmentId: r.department?.id, due_date: r.return_by, requisitionId: r.id, lines: post, allowIssueReturnable: r.type !== 'borrow' });
      } catch (e) { return L.bad(ctx, e.message, e.status || 400); }
      post.forEach((p) => { lines[p.idx].qty_issued = (lines[p.idx].qty_issued || 0) + p.qty; });
    }
    const complete = lines.every((l) => (l.qty_issued || 0) >= l.qty_approved);
    const status = complete ? 'issued' : 'partly_issued';
    await db(U.req).update(r.id, { lines, status, history: hist(r, user.username, `${complete ? 'Issued' : 'Part issued'} by ${user.full_name}`) });
    if (r.requester_user) await L.notify([r.requester_user.id], `${r.number}: ${complete ? 'ready — please confirm receipt' : 'part issued'}`, '', `/requisitions/${r.id}`);
    return module.exports.get(ctx);
  },

  /** Requester confirms (in app) or store scans requester's card at the counter. */
  async confirm(ctx) {
    const user = ctx.state.appUser;
    const r = await db(U.req).byId(ctx.params.id, POP);
    if (!r || !['issued', 'partly_issued'].includes(r.status)) return L.bad(ctx, 'Nothing to confirm', 409);
    const code = ctx.request.body?.cardCode;
    let ok = r.requester_user?.id === user.id;
    if (!ok && code) {
      const s = await db(U.staff).one({ where: { $or: [{ card_number: { $eqi: code } }, { staff_id: { $eqi: code } }] } });
      ok = s && s.id === r.requester?.id;
    }
    if (!ok) return L.bad(ctx, 'Only the requester can confirm receipt (or scan their card)', 403);
    if (r.status === 'partly_issued') {
      await db(U.req).update(r.id, { history: hist(r, user.username, 'Received the part issued so far') });
      return module.exports.get(ctx);
    }
    const loansOpen = r.type === 'borrow' ? await db(U.tx).count({ requisition: { id: r.id }, type: 'lend', loan_status: 'open' }) : 0;
    await db(U.req).update(r.id, { status: r.type === 'borrow' && !loansOpen ? 'returned' : 'received', received_at: new Date(), history: hist(r, user.username, 'Receipt confirmed') });
    return module.exports.get(ctx);
  },

  async cancel(ctx) {
    const user = ctx.state.appUser;
    const r = await db(U.req).byId(ctx.params.id, { requester_user: true });
    if (!r || r.requester_user?.id !== user.id || !['draft', 'submitted', 'returned_to_requester'].includes(r.status)) return L.bad(ctx, 'Cannot cancel now', 409);
    await db(U.req).update(r.id, { status: 'cancelled', history: hist(r, user.username, 'Cancelled by requester') });
    return { ok: true };
  },

  async route(ctx) {
    // preview of the approval route before submitting
    const user = ctx.state.appUser;
    const { lines, total } = await linesFrom(ctx.request.body?.lines);
    const steps = await buildSteps({ type: ctx.request.body?.type || 'consumable', department: L.idOf(ctx.request.body?.departmentId) || user.staff?.dept, total_value: total }, lines);
    const named = [];
    for (const s of steps) {
      const people = await L.usersWithRole(s.role, s.role === 'Manager' ? { dept: user.staff?.dept } : {});
      named.push({ role: s.role, people: people.map((p) => p.full_name || p.username).slice(0, 3), rule: s.rule || null });
    }
    return { steps: named, total };
  },
};

async function notifyStep(r, step, suffix = 'waiting for your approval') {
  if (!step) return;
  const people = await L.usersWithRole(step.role, step.role === 'Manager' ? { dept: r.department?.id ?? r.department } : { branch: r.branch?.id ?? r.branch });
  await L.notify(people.map((p) => p.id), `${r.number} ${suffix}`, r.purpose || '', `/requisitions/${r.id}`);
}
