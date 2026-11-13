'use strict';
const L = require('../lib');
const { U, db } = L;
const { clean } = require('./resources');

async function level(storeId, itemId) {
  let l = await db(U.level).one({ where: { store: { id: storeId }, item: { id: itemId } } });
  if (!l) l = await db(U.level).create({ store: storeId, item: itemId, qty: 0 });
  return l;
}
async function addQty(storeId, itemId, delta) {
  const l = await level(storeId, itemId);
  const q = Number(l.qty || 0) + Number(delta);
  await db(U.level).update(l.id, { qty: q });
  return q;
}
async function resolveTaker(code, id) {
  if (id) return db(U.staff).byId(id, { dept: true });
  if (!code) return null;
  return db(U.staff).one({ where: { $or: [{ card_number: { $eqi: code } }, { staff_id: { $eqi: code } }] }, populate: { dept: true } });
}

/**
 * Core movement of stock; used by the issue screen and by requisition issue.
 * lines: [{ itemId, qty, unit_cost?, expiry_date?, batch? }]
 */
async function post(ctx, b) {
  const user = ctx.state.appUser;
  const type = b.type;
  if (!['receive', 'issue', 'lend', 'adjust', 'write_off', 'transfer'].includes(type)) throw Object.assign(new Error('Unknown transaction type'), { status: 400 });
  if (['adjust', 'write_off'].includes(type) && !L.can(user, 'store', 'approve')) throw Object.assign(new Error('Stock adjustments need the Store Manager'), { status: 403 });
  const store = await db(U.store).byId(L.idOf(b.storeId), { branch: true });
  if (!store) throw Object.assign(new Error('Choose a store'), { status: 400 });
  const lines = (b.lines || []).filter((l) => l && l.itemId && Number(l.qty));
  if (!lines.length) throw Object.assign(new Error('Add at least one item with a quantity'), { status: 400 });
  let taker = null;
  if (['issue', 'lend'].includes(type)) {
    taker = await resolveTaker(b.takerCode, b.takerId);
    if (!taker) throw Object.assign(new Error('Scan the card of the person taking the items'), { status: 400 });
  }
  const dept = L.idOf(b.departmentId) || taker?.dept?.id || null;
  // validate stock first so nothing is half-posted
  const items = {};
  for (const l of lines) {
    const it = await db(U.item).byId(l.itemId);
    if (!it) throw Object.assign(new Error('Unknown item'), { status: 400 });
    items[l.itemId] = it;
    if (['issue', 'lend', 'write_off', 'transfer'].includes(type)) {
      const lv = await level(store.id, it.id);
      if (Number(lv.qty || 0) < Number(l.qty)) throw Object.assign(new Error(`${it.name}: only ${Number(lv.qty || 0)} ${it.unit || ''} in ${store.name}`), { status: 409 });
    }
    if (type === 'lend' && it.kind !== 'returnable') throw Object.assign(new Error(`${it.name} is a consumable — use Issue`), { status: 400 });
    if (type === 'issue' && it.kind === 'returnable' && !b.allowIssueReturnable) throw Object.assign(new Error(`${it.name} must come back — use Lend`), { status: 400 });
  }
  const now = new Date();
  const out = [];
  for (const l of lines) {
    const it = items[l.itemId];
    const qty = Number(l.qty);
    const base = { store: store.id, item: it.id, qty, issued_by: user.username, happened_at: now, requisition: L.idOf(b.requisitionId) || null, reason: b.reason || null };
    if (type === 'receive') {
      out.push(await db(U.tx).create({ ...base, type, unit_cost: L.num(l.unit_cost) ?? it.unit_cost, supplier: b.supplier || null, delivery_note: b.delivery_note || null, expiry_date: l.expiry_date || null, batch: l.batch || null }));
      await addQty(store.id, it.id, qty);
      if (L.num(l.unit_cost)) await db(U.item).update(it.id, { unit_cost: L.num(l.unit_cost) });
    } else if (type === 'issue' || type === 'lend') {
      out.push(await db(U.tx).create({ ...base, type, taker: taker.id, department: dept, linked_asset: L.idOf(l.linkedAssetId || b.linkedAssetId) || null, due_date: type === 'lend' ? (b.due_date || null) : null, condition_out: b.condition_out || null, loan_status: type === 'lend' ? 'open' : null, returned_qty: 0, unit_cost: it.unit_cost }));
      await addQty(store.id, it.id, -qty);
    } else if (type === 'adjust') {
      out.push(await db(U.tx).create({ ...base, type, approved_by: user.username }));
      await addQty(store.id, it.id, qty);
      if (Math.abs(qty) * Number(it.unit_cost || 0) >= Number(L.env('VARIANCE_CASE_VALUE', 100000))) {
        await L.openCase(ctx, { type: 'stock_variance', severity: 'medium', title: `Stock variance: ${it.name} ${qty > 0 ? '+' : ''}${qty} ${it.unit || ''}, ${store.name}`, description: b.reason || '', branch: store.branch?.id || null });
      }
    } else if (type === 'write_off') {
      out.push(await db(U.tx).create({ ...base, type, approved_by: user.username }));
      await addQty(store.id, it.id, -qty);
    } else if (type === 'transfer') {
      const to = await db(U.store).byId(L.idOf(b.toStoreId));
      if (!to) throw Object.assign(new Error('Choose the receiving store'), { status: 400 });
      out.push(await db(U.tx).create({ ...base, type: 'transfer_out' }));
      out.push(await db(U.tx).create({ ...base, type: 'transfer_in', store: to.id }));
      await addQty(store.id, it.id, -qty); await addQty(to.id, it.id, qty);
    }
  }
  await L.audit(ctx, type, 'stock', out.map((x) => x.id).join(','), null, { store: store.name, lines: lines.length, taker: taker?.staff_name });
  return { transactions: out, taker };
}

module.exports = {
  post,

  async tx(ctx) {
    try {
      const r = await post(ctx, ctx.request.body || {});
      return { ok: true, count: r.transactions.length, taker: r.taker ? { id: r.taker.id, name: r.taker.staff_name } : null };
    } catch (e) { return L.bad(ctx, e.message, e.status || 400); }
  },

  async stock(ctx) {
    const storeId = L.idOf(ctx.query.storeId);
    const items = await db(U.item).find({ where: { active: true, ...(ctx.query.q ? { $or: [{ name: { $containsi: ctx.query.q } }, { code: { $containsi: ctx.query.q } }] } : {}) }, orderBy: { name: 'asc' }, limit: 500 });
    const levels = await db(U.level).find({ where: storeId ? { store: { id: storeId } } : {}, populate: { item: true, store: true } });
    const qty = {};
    levels.forEach((l) => { const k = l.item?.id; if (k) qty[k] = (qty[k] || 0) + Number(l.qty || 0); });
    const openLoans = await db(U.tx).find({ where: { type: 'lend', loan_status: 'open', ...(storeId ? { store: { id: storeId } } : {}) }, populate: { item: true } });
    const out = {};
    openLoans.forEach((t) => { const k = t.item?.id; if (k) out[k] = (out[k] || 0) + Number(t.qty) - Number(t.returned_qty || 0); });
    return {
      data: items.map((i) => ({ ...i, qty: qty[i.id] || 0, on_loan: out[i.id] || 0, low: i.reorder_level != null && (qty[i.id] || 0) <= Number(i.reorder_level), value: (qty[i.id] || 0) * Number(i.unit_cost || 0) })),
    };
  },

  async loans(ctx) {
    const where = { type: 'lend', loan_status: ctx.query.all ? { $in: ['open', 'returned', 'written_off'] } : 'open' };
    if (ctx.query.takerId) where.taker = { id: ctx.query.takerId };
    const rows = await db(U.tx).find({ where, populate: { item: true, taker: { populate: { dept: true } }, store: true, requisition: true }, orderBy: { due_date: 'asc' }, limit: 500 });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return { data: clean(rows).map((r) => ({ ...r, outstanding: Number(r.qty) - Number(r.returned_qty || 0), overdue: r.due_date && new Date(r.due_date) < today, dueToday: r.due_date && new Date(r.due_date).toDateString() === today.toDateString() })) };
  },

  async returnLoan(ctx) {
    const { loanId, qty, condition_in, writeOff, reason } = ctx.request.body || {};
    const loan = await db(U.tx).byId(loanId, { item: true, store: true, requisition: true, taker: true });
    if (!loan || loan.type !== 'lend') return L.bad(ctx, 'Loan not found', 404);
    const outstanding = Number(loan.qty) - Number(loan.returned_qty || 0);
    const q = Math.min(Number(qty) || outstanding, outstanding);
    if (q <= 0) return L.bad(ctx, 'Nothing outstanding on this loan');
    const now = new Date();
    if (writeOff) {
      if (!L.can(ctx.state.appUser, 'store', 'approve')) return L.bad(ctx, 'Only the Store Manager can write off a loan', 403);
      await db(U.tx).create({ type: 'write_off', store: loan.store.id, item: loan.item.id, qty: q, loan: loan.id, issued_by: ctx.state.appUser.username, reason: reason || 'Not returned', happened_at: now });
    } else {
      await db(U.tx).create({ type: 'return', store: loan.store.id, item: loan.item.id, qty: q, loan: loan.id, taker: loan.taker?.id || null, condition_in: condition_in || null, issued_by: ctx.state.appUser.username, happened_at: now });
      await addQty(loan.store.id, loan.item.id, q);
    }
    const returned = Number(loan.returned_qty || 0) + q;
    const done = returned >= Number(loan.qty);
    await db(U.tx).update(loan.id, { returned_qty: returned, loan_status: done ? (writeOff ? 'written_off' : 'returned') : 'open', condition_in: condition_in || loan.condition_in });
    if (done && loan.requisition) {
      const open = await db(U.tx).count({ requisition: { id: loan.requisition.id }, type: 'lend', loan_status: 'open' });
      if (!open && loan.requisition.status === 'received') await db(U.req).update(loan.requisition.id, { status: 'returned' });
    }
    return { ok: true, returned, done };
  },

  /** Expiring receipts and overdue loans → used by the alerts panel and the nightly job. */
  async alerts(ctx) {
    const soon = new Date(Date.now() + 30 * 864e5);
    const exp = await db(U.tx).find({ where: { type: 'receive', expiry_date: { $notNull: true, $lte: soon.toISOString().slice(0, 10) } }, populate: { item: true, store: true }, orderBy: { expiry_date: 'asc' }, limit: 50 });
    return { expiring: clean(exp) };
  },
};
