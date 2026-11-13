'use strict';
const L = require('../lib');
const { U, db } = L;
const { clean, relData } = require('./resources');

const POP = { assigned_to: { populate: { dept: true } }, category_ref: true, branch: true, office: true, last_access_point: true, visit: { populate: { visitor: true } } };

function moduleFor(ownership) { return ownership && ownership !== 'company' ? 'noncompany' : 'assets'; }

async function restoreStatus(a) {
  return a.assigned_to ? 'assigned' : (a.previous_status && !['lost', 'decommissioned'].includes(a.previous_status) ? a.previous_status : 'available');
}

module.exports = {
  /** Create one or many (quantity) items; tags generated per ownership/category. */
  async create(ctx) {
    const user = ctx.state.appUser;
    const body = ctx.request.body || {};
    const data = relData(U.asset, body.data || body);
    data.ownership = data.ownership || 'company';
    const mod = moduleFor(data.ownership);
    if (!L.can(user, mod, 'create')) return L.bad(ctx, 'Not allowed', 403);
    if (!data.asset_name) return L.bad(ctx, 'Name is required');
    const qty = Math.max(1, Math.min(Number(body.quantity) || 1, 500));
    const cat = data.category_ref ? await db(U.category).byId(data.category_ref) : null;
    if (cat) { data.category = cat.name; if (!data.gate_rule) data.gate_rule = cat.gate_rule_default; }
    if (cat?.is_vehicle) {
      if (!data.serial_number) return L.bad(ctx, 'Enter the number plate (in the Serial / plate field)');
      data.serial_number = String(data.serial_number).replace(/\s+/g, '').toUpperCase();
      if (qty > 1) return L.bad(ctx, 'Add vehicles one at a time — each has its own plate');
    }
    if (!data.branch && user.staff && !user.allBranches && user.branchIds.length === 1) data.branch = user.branchIds[0];

    if (data.ownership === 'personal') {
      // staff register their own; approvers may register for someone else
      if (!L.can(user, 'noncompany', 'approve')) {
        if (!user.staff) return L.bad(ctx, 'Your login is not linked to a staff record', 403);
        data.assigned_to = user.staff.id;
        data.approval_status = 'pending';
      } else data.approval_status = data.approval_status || 'approved';
      data.gate_rule = 'portable';
    }
    if (data.serial_number) {
      const dup = await db(U.asset).one({ where: { serial_number: { $eqi: data.serial_number }, ownership: data.ownership } });
      if (dup) return L.bad(ctx, `Serial ${data.serial_number} already exists on ${dup.tag_number}`, 409);
    }
    let tags = [];
    if (data.tag_number && qty === 1) {
      const dup = await db(U.asset).one({ where: { tag_number: { $eqi: data.tag_number } } });
      if (dup) return L.bad(ctx, `Tag ${data.tag_number} already exists`, 409);
      tags = [data.tag_number];
    } else tags = await L.nextTags(L.tagPrefixFor(data.ownership, cat), qty, data.ownership === 'company' && !cat?.tag_prefix ? 6 : 4);
    data.asset_status = data.asset_status || (data.assigned_to ? 'assigned' : 'available');
    const created = [];
    for (const tag of tags) {
      const row = await db(U.asset).create({ ...data, tag_number: tag, serial_number: qty > 1 ? null : data.serial_number });
      await L.history(ctx, row.id, 'create', { notes: qty > 1 ? `Bulk created (${qty})` : 'Created', new_assignee: data.assigned_to ? String(data.assigned_to) : null });
      created.push(row);
    }
    await L.audit(ctx, 'create', 'asset', created.map((r) => r.id).join(','), null, { qty, tags: [tags[0], tags[tags.length - 1]] });
    if (data.ownership === 'personal' && data.approval_status === 'pending') {
      const sups = await L.usersWithRole('Security Supervisor');
      await L.notify(sups.map((u) => u.id), 'Personal item to check', `${data.asset_name} registered by ${user.full_name}`, '/assets/non-company');
    }
    return { data: clean(created), tags };
  },

  async get(ctx) {
    const a = await db(U.asset).byId(ctx.params.id, POP);
    if (!a) return L.bad(ctx, 'Not found', 404);
    if (!L.can(ctx.state.appUser, moduleFor(a.ownership), 'view') && !L.can(ctx.state.appUser, 'investigations', 'view')) return L.bad(ctx, 'Not allowed', 403);
    const [hist, moves, cases] = await Promise.all([
      db(U.history).find({ where: { company_asset: { id: a.id } }, orderBy: { event_date: 'desc' }, limit: 50 }),
      db(U.movement).find({ where: { asset: { id: a.id } }, orderBy: { scanned_at: 'desc' }, limit: 30, populate: { person: true, access_point: true } }),
      db(U.case).find({ where: { asset: { id: a.id } }, orderBy: { id: 'desc' } }),
    ]);
    return { data: clean(a), history: clean(hist), movements: clean(moves), cases: clean(cases) };
  },

  /** Track asset (gate F3 / search): tag or serial → asset + last movements. */
  async lookup(ctx) {
    const k = String(ctx.params.code || '').trim();
    const a = await db(U.asset).one({ where: { $or: [{ tag_number: { $eqi: k } }, { serial_number: { $eqi: k } }] }, populate: POP });
    if (!a) return L.bad(ctx, 'Not found', 404);
    ctx.params.id = a.id;
    return module.exports.get(ctx);
  },

  /** Lifecycle on one or many: assign | unassign | transfer | lost | found | repair | decommission */
  async action(ctx) {
    const user = ctx.state.appUser;
    const { action, ids = [], staffId, officeId, reason, notes, place, date, disposal } = ctx.request.body || {};
    if (!ids.length) return L.bad(ctx, 'Select at least one item');
    const rows = await db(U.asset).find({ where: { id: { $in: ids } }, populate: { assigned_to: true } });
    const need = action === 'decommission' ? 'approve' : 'edit';
    for (const a of rows) {
      const mod = moduleFor(a.ownership);
      const holderSelf = action === 'lost' && ((user.staff && a.assigned_to?.id === user.staff.id) || L.can(user, 'investigations', 'create'));
      if (!holderSelf && !L.can(user, mod, need)) return L.bad(ctx, action === 'decommission' ? 'Decommissioning needs Branch Admin approval' : 'Not allowed', 403);
    }
    const staff = staffId ? await db(U.staff).byId(staffId) : null;
    if (['assign', 'transfer'].includes(action) && !staff && !officeId) return L.bad(ctx, 'Choose a person or an office');
    if (['lost', 'decommission'].includes(action) && !reason && !notes) return L.bad(ctx, 'Give a reason');
    const results = [];
    for (const a of rows) {
      const prev = a.assigned_to;
      let data = {};
      let kind = action;
      switch (action) {
        case 'assign': case 'transfer':
          if (a.asset_status === 'lost' || a.asset_status === 'decommissioned') return L.bad(ctx, `${a.tag_number} is ${a.asset_status}`, 409);
          data = { assigned_to: staff?.id ?? prev?.id ?? null, office: officeId || a.office?.id || null, asset_status: staff || prev ? 'assigned' : 'available' };
          kind = prev && staff && prev.id !== staff.id ? 'transfer' : 'assign';
          break;
        case 'unassign': data = { assigned_to: null, asset_status: 'available' }; break;
        case 'repair': data = { asset_status: 'in_repair', previous_status: a.asset_status }; break;
        case 'found': data = { asset_status: await restoreStatus(a) }; break;
        case 'lost': data = { asset_status: 'lost', previous_status: a.asset_status }; break;
        case 'decommission': data = { asset_status: 'decommissioned', previous_status: a.asset_status }; break;
        default: return L.bad(ctx, 'Unknown action');
      }
      await db(U.asset).update(a.id, data);
      await L.history(ctx, a.id, kind === 'transfer' ? 'transfer' : kind, { reason: reason || null, notes: notes || null, previous_assignee: prev?.staff_name || null, new_assignee: staff?.staff_name || null, extra: { place, date, disposal } });
      if (action === 'lost') {
        await L.openCase(ctx, { type: 'lost_reported', severity: 'critical', title: `Reported lost: ${a.asset_name} (${a.tag_number})`, description: [reason, notes, place && `Place: ${place}`, date && `Date: ${date}`].filter(Boolean).join('\n'), asset: a.id, staff: prev?.id || null, branch: a.branch?.id || null });
      }
      if (action === 'found') {
        const open = await db(U.case).find({ where: { asset: { id: a.id }, status: { $notIn: ['resolved', 'closed'] } } });
        for (const c of open) { await L.addCaseNote(c.id, user.username, 'Item marked found from the register'); await db(U.case).update(c.id, { status: 'resolved', outcome: 'found', closed_at: new Date() }); }
      }
      if (staff && kind === 'transfer') {
        const rec = await db(U.user).find({ where: { staff: { id: staff.id } } });
        await L.notify(rec.map((r) => r.id), 'Item transferred to you', `${a.asset_name} (${a.tag_number})`, '/me');
      }
      results.push(a.id);
    }
    await L.audit(ctx, action, 'asset', results.join(','), null, { staffId, officeId, reason });
    return { ok: true, count: results.length };
  },

  async approvePersonal(ctx) {
    const a = await db(U.asset).byId(ctx.params.id);
    if (!a || a.ownership !== 'personal') return L.bad(ctx, 'Not a personal item', 404);
    const approve = ctx.request.body?.approve !== false;
    await db(U.asset).update(a.id, { approval_status: approve ? 'approved' : 'rejected' });
    await L.history(ctx, a.id, 'update', { notes: approve ? 'Personal item approved' : 'Personal item rejected', reason: ctx.request.body?.reason || null });
    return { ok: true };
  },

  /** Items the logged-in staff member holds (self-service). */
  async mine(ctx) {
    const s = ctx.state.appUser.staff;
    if (!s) return { data: [] };
    const rows = await db(U.asset).find({ where: { assigned_to: { id: s.id }, asset_status: { $ne: 'decommissioned' } }, populate: { category_ref: true, office: true }, orderBy: { tag_number: 'asc' } });
    return { data: clean(rows) };
  },
};
