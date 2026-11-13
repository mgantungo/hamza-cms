'use strict';
const L = require('../lib');
const { U, db } = L;
const { clean } = require('./resources');

const ASSET_POP = { assigned_to: true, category_ref: true, last_access_point: { populate: { branch: true } }, visit: true, branch: true };

async function context(ctx) {
  const t = await L.terminalFromCtx(ctx);
  let ap = t?.access_point || null;
  const body = ctx.request.body || {};
  if (!ap && (body.accessPointId || ctx.query.accessPointId)) ap = await db(U.ap).byId(body.accessPointId || ctx.query.accessPointId, { branch: true });
  return { terminal: t, ap, branchId: ap?.branch?.id || null };
}

function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

async function heldBy(staffId) {
  const rows = await db(U.asset).find({ where: { assigned_to: { id: staffId }, asset_status: { $notIn: ['decommissioned'] }, $or: [{ ownership: 'company' }, { ownership: 'personal' }] }, populate: { category_ref: true }, orderBy: { tag_number: 'asc' } });
  return rows.map((a) => ({ id: a.id, tag: a.tag_number, name: a.asset_name, ownership: a.ownership, gate_rule: a.gate_rule, status: a.asset_status, category: a.category_ref?.name || a.category }));
}

async function visitPayload(visit) {
  const items = await db(U.asset).find({ where: { visit: { id: visit.id }, ownership: 'visitor' } });
  return { visit: clean(visit), items: items.map((a) => ({ id: a.id, tag: a.tag_number, name: a.asset_name, description: a.description, serial: a.serial_number, location_state: a.location_state })) };
}

async function watchCase(ctx, guest, c) {
  await L.openCase(ctx, { type: 'watchlist', severity: 'high', title: `Watchlist person at ${c.ap?.name || 'gate'}: ${guest.guest_name}`, description: guest.watchlist_reason || '', branch: c.branchId, access_point: c.ap?.id || null });
}

module.exports = {
  /** Work out what a scanned code is: staff card, visitor badge, invite, national ID, vehicle. */
  async identify(ctx) {
    const code = String(ctx.request.body?.code || '').trim();
    if (!code) return L.bad(ctx, 'Nothing scanned');
    const c = await context(ctx);

    // vehicle windshield QR ({"assetId","assetType":"vehicle","recordId"} or VEHICLE|PLATE) → vehicle gate screen
    const vq = require('./vehicles').parseVehicleCode(code);
    if (vq) return { type: 'vehicle', plate: vq.plate, recordId: vq.recordId };

    const badge = await db(U.badge).one({ where: { number: { $eqi: code } } });
    if (badge) {
      const visit = await db(U.visit).one({ where: { badge: { id: badge.id }, status: 'in_building' }, populate: { visitor: true, host: true, badge: true }, orderBy: { id: 'desc' } });
      if (!visit) return L.bad(ctx, `Badge ${badge.number} is not issued to anyone inside`, 404);
      return { type: 'visitor_exit', ...(await visitPayload(visit)) };
    }

    if (/^INV-/i.test(code)) {
      const ap = await db(U.appointment).one({ where: { invite_code: { $eqi: code } }, populate: { host: true } });
      if (!ap) return L.bad(ctx, 'Invite code not found', 404);
      if (ap.status !== 'booked') return L.bad(ctx, `Invite already ${ap.status.replace('_', ' ')}`, 409);
      return { type: 'appointment', appointment: clean(ap) };
    }

    const staff = await db(U.staff).one({ where: { $or: [{ card_number: { $eqi: code } }, { staff_id: { $eqi: code } }, { national_id: code }] }, populate: { dept: true, branch: true } });
    if (staff) {
      const blocked = staff.status && staff.status !== 'active';
      return { type: 'staff', blocked, blockedReason: blocked ? `Staff status: ${staff.status}` : null, staff: { id: staff.id, staff_id: staff.staff_id, card: staff.card_number, name: staff.staff_name, department: staff.dept?.name || staff.department, position: staff.position, photo_url: staff.photo_url }, held: await heldBy(staff.id) };
    }

    const guest = await db(U.guest).one({ where: { nin: { $eqi: code } } });
    if (guest) {
      const visit = await db(U.visit).one({ where: { visitor: { id: guest.id }, status: 'in_building' }, populate: { visitor: true, host: true, badge: true }, orderBy: { id: 'desc' } });
      if (visit) return { type: 'visitor_exit', ...(await visitPayload(visit)) };
      if (guest.watchlist) await watchCase(ctx, guest, c);
      return { type: 'guest', guest: clean(guest), watchlist: !!guest.watchlist, watchlistReason: guest.watchlist_reason || null };
    }

    const plate = code.replace(/\s+/g, '').toUpperCase();
    const veh = await db(U.asset).one({ where: { serial_number: { $eqi: plate }, category_ref: { is_vehicle: true } } });
    if (veh) return { type: 'vehicle', plate };

    return L.bad(ctx, 'Card not recognised. Scan again or press F3 to search by name.', 404);
  },

  /** One item scanned for the current person or visit. Saves a movement right away. */
  async scanItem(ctx) {
    const { code, staffId, visitId, direction: forced } = ctx.request.body || {};
    const c = await context(ctx);
    if (!c.ap) return L.bad(ctx, 'This PC is not enrolled to an access point', 412);
    const k = String(code || '').trim();
    if (!k) return L.bad(ctx, 'Nothing scanned');
    const asset = await db(U.asset).one({ where: { $or: [{ tag_number: { $eqi: k } }, { serial_number: { $eqi: k } }] }, populate: ASSET_POP });
    if (!asset) {
      const item = await db(U.item).one({ where: { code: { $eqi: k } } });
      if (item) return L.bad(ctx, `${item.name} is a store item, not a tracked asset`, 404);
      return L.bad(ctx, 'Item not found. Scan again.', 404);
    }

    // direction: forced (F5) > item's own state > the person's last movement > time of day
    let direction = forced;
    if (!direction) {
      if (asset.location_state === 'inside' && (!asset.last_access_point?.branch || asset.last_access_point.branch.id === c.branchId)) direction = 'OUT';
      else if (asset.location_state === 'outside') direction = 'IN';
      else if (asset.ownership === 'visitor') direction = 'OUT';
      else {
        const last = staffId ? await db(U.movement).one({ where: { person: { id: staffId } }, orderBy: { scanned_at: 'desc' } }) : null;
        direction = last ? (last.direction === 'IN' ? 'OUT' : 'IN') : (new Date().getHours() < 13 ? 'IN' : 'OUT');
      }
    }

    // rules by ownership
    let exception = null;
    const holder = asset.assigned_to;
    if (asset.ownership === 'company') {
      if (asset.asset_status === 'lost') exception = { type: 'lost_scanned', severity: 'critical', reason: 'Reported lost' };
      else if (asset.asset_status === 'decommissioned') exception = { type: 'decommissioned_at_gate', severity: 'high', reason: 'Decommissioned item' };
      else if (asset.gate_rule === 'fixed') exception = { type: 'fixed_item_at_gate', severity: 'medium', reason: 'Fixed item must not leave its office' };
      else if (visitId) exception = { type: 'unauthorised_carry', severity: 'high', reason: 'Company item carried by a visitor' };
      else if (!holder || holder.id !== Number(staffId)) exception = { type: 'unauthorised_carry', severity: 'high', reason: 'Not assigned to this person' };
    } else if (asset.ownership === 'personal') {
      if (!holder || holder.id !== Number(staffId)) exception = { type: 'personal_wrong_carrier', severity: 'high', reason: 'Personal item of someone else' };
    } else if (asset.ownership === 'visitor') {
      if (!visitId || asset.visit?.id !== Number(visitId)) exception = { type: 'visitor_item_mismatch', severity: 'high', reason: 'Belongs to a different visit' };
    } else if (asset.ownership === 'third_party') {
      if (asset.permit_end && new Date(asset.permit_end) < startOfDay()) exception = { type: 'permit_expired', severity: 'medium', reason: 'Permit or contract has ended' };
    }

    const now = new Date();
    const person = staffId ? await db(U.staff).byId(staffId) : null;
    let caseRow = null;
    if (exception) {
      if (exception.type === 'lost_scanned') {
        caseRow = await db(U.case).one({ where: { asset: { id: asset.id }, status: { $notIn: ['resolved', 'closed'] } }, orderBy: { id: 'desc' } });
        if (caseRow) {
          await L.addCaseNote(caseRow.id, ctx.state.appUser.username, `SCANNED at ${c.ap.name} carried by ${person?.staff_name || 'a visitor'}`, 'gate');
          const sups = await L.usersWithRole('Security Supervisor', { branch: c.branchId });
          await L.notify([...sups.map((u) => u.id), caseRow.investigator?.id], `${caseRow.number}: lost item seen at ${c.ap.name}`, asset.asset_name, `/security/investigations/${caseRow.id}`);
        }
      }
      if (!caseRow) {
        caseRow = await L.openCase(ctx, { type: exception.type, severity: exception.severity, title: `${exception.reason}: ${asset.asset_name} (${asset.tag_number})`, description: `Scanned ${direction} at ${c.ap.name} carried by ${person?.staff_name || 'visitor'}${holder ? `; assigned to ${holder.staff_name}` : ''}`, asset: asset.id, staff: person?.id || null, visit: visitId || null, branch: c.branchId, access_point: c.ap.id });
      }
    }

    const mv = await db(U.movement).create({ asset: asset.id, person: person?.id || null, visit: visitId || null, direction, access_point: c.ap.id, branch: c.branchId, terminal: c.terminal?.id || null, guard: ctx.state.appUser.username, result: exception ? 'exception' : 'ok', reason: exception?.reason || null, investigation: caseRow?.id || null, scanned_at: now, method: 'scan' });
    await db(U.asset).update(asset.id, { location_state: direction === 'IN' ? 'inside' : 'outside', last_access_point: c.ap.id, last_seen_at: now });

    return {
      movementId: mv.id, direction, result: exception ? 'exception' : 'ok',
      exception: exception ? { ...exception, caseId: caseRow?.id, caseNumber: caseRow?.number } : null,
      item: { id: asset.id, tag: asset.tag_number, name: asset.asset_name, ownership: asset.ownership, assignedTo: holder ? holder.staff_name : null, assignedDept: holder?.department || null },
    };
  },

  async acknowledge(ctx) {
    const { movementId, cardCode } = ctx.request.body || {};
    const mv = await db(U.movement).byId(movementId, { investigation: true });
    if (!mv) return L.bad(ctx, 'Movement not found', 404);
    let by = ctx.state.appUser.username;
    if (cardCode) {
      const s = await db(U.staff).one({ where: { $or: [{ card_number: { $eqi: cardCode } }, { staff_id: { $eqi: cardCode } }] } });
      if (!s || ctx.state.appUser.staff?.id !== s.id) return L.bad(ctx, 'Scan your own staff card to acknowledge', 403);
    }
    await db(U.movement).update(mv.id, { acknowledged_by: by });
    if (mv.investigation) await L.addCaseNote(mv.investigation.id, by, 'Exception acknowledged at the gate; item held', 'gate');
    return { ok: true };
  },

  async today(ctx) {
    const c = await context(ctx);
    const where = { scanned_at: { $gte: startOfDay() }, ...(c.ap ? { access_point: { id: c.ap.id } } : {}) };
    const [ins, outs, exc, last] = await Promise.all([
      db(U.movement).count({ ...where, direction: 'IN' }), db(U.movement).count({ ...where, direction: 'OUT' }),
      db(U.movement).count({ ...where, result: 'exception' }),
      db(U.movement).find({ where, orderBy: { scanned_at: 'desc' }, limit: Number(ctx.query.limit) || 12, populate: { asset: true, person: true, visit: { populate: { visitor: true } } } }),
    ]);
    return { counts: { in: ins, out: outs, exceptions: exc }, last: clean(last) };
  },

  /** Gate (F4) or reception walk-in: creates/updates the visitor, a waiting visit and the visitor's items. */
  async registerVisitor(ctx) {
    const b = ctx.request.body || {};
    const c = await context(ctx);
    let guest = b.guestId ? await db(U.guest).byId(b.guestId) : null;
    let appt = b.appointmentId ? await db(U.appointment).byId(b.appointmentId, { host: true }) : null;
    const name = b.name || appt?.visitor_name;
    if (!name) return L.bad(ctx, 'Visitor name is required');
    const nin = b.nin || appt?.id_number || null;
    if (!guest && nin) guest = await db(U.guest).one({ where: { nin: { $eqi: nin } } });
    const gdata = { guest_name: name, nin, phone: b.phone || appt?.phone || null, organisation: b.organisation || appt?.organisation || null, email: b.email || appt?.email || null, id_type: b.id_type || appt?.id_type || null };
    guest = guest ? await db(U.guest).update(guest.id, Object.fromEntries(Object.entries(gdata).filter(([, v]) => v))) : await db(U.guest).create(gdata);
    if (guest.watchlist) await watchCase(ctx, guest, c);

    const visit = await db(U.visit).create({ visitor: guest.id, appointment: appt?.id || null, host: b.hostId || appt?.host?.id || null, purpose: b.purpose || appt?.purpose || null, branch: c.branchId || L.idOf(b.branchId) || null, access_point_in: c.ap?.id || null, status: 'waiting', arrived_at: new Date(), registered_by: ctx.state.appUser.username });
    if (appt) await db(U.appointment).update(appt.id, { status: 'arrived', visit: visit.id });
    const items = await addVisitorItems(ctx, visit, b.items || [], c);
    // tell reception
    const rec = await L.usersWithRole('Reception', { branch: visit.branch?.id || c.branchId });
    await L.notify(rec.map((u) => u.id), `Visitor waiting: ${name}`, appt ? `Appointment with ${appt.host?.staff_name || 'host'}` : 'Walk-in', '/reception');
    await L.audit(ctx, 'register', 'visit', visit.id, null, { name, items: items.length });
    return { visit: clean(visit), guest: clean(guest), items, watchlist: !!guest.watchlist, watchlistReason: guest.watchlist_reason || null };
  },

  /** Visitor leaving: closes the visit, frees the badge, flags items left behind. */
  async visitCheckout(ctx) {
    const { visitId, confirmedIds = [] } = ctx.request.body || {};
    const c = await context(ctx);
    const visit = await db(U.visit).byId(visitId, { visitor: true, badge: true });
    if (!visit) return L.bad(ctx, 'Visit not found', 404);
    const items = await db(U.asset).find({ where: { visit: { id: visit.id }, ownership: 'visitor' } });
    const now = new Date();
    const left = [];
    for (const it of items) {
      if (it.location_state === 'outside') continue;
      if (confirmedIds.map(Number).includes(it.id)) {
        await db(U.movement).create({ asset: it.id, visit: visit.id, direction: 'OUT', access_point: c.ap?.id || null, branch: c.branchId, terminal: c.terminal?.id || null, guard: ctx.state.appUser.username, result: 'ok', reason: 'Confirmed seen (no sticker)', scanned_at: now, method: 'manual' });
        await db(U.asset).update(it.id, { location_state: 'outside', last_access_point: c.ap?.id || null, last_seen_at: now });
      } else left.push(it);
    }
    if (left.length) {
      await L.openCase(ctx, { type: 'left_behind', severity: 'low', title: `Visitor items not checked out: ${visit.visitor?.guest_name}`, description: left.map((i) => `${i.asset_name} ${i.serial_number || ''}`).join(', '), visit: visit.id, branch: c.branchId, access_point: c.ap?.id || null });
    }
    if (visit.badge) await db(U.badge).update(visit.badge.id, { status: 'available' });
    await db(U.visit).update(visit.id, { status: 'checked_out', checked_out_at: now, access_point_out: c.ap?.id || null });
    return { ok: true, leftBehind: left.map((i) => ({ id: i.id, name: i.asset_name })) };
  },

  /** F3 – find a person or asset by name/tag. */
  async find(ctx) {
    const q = String(ctx.query.q || '').trim();
    if (q.length < 2) return { staff: [], assets: [] };
    const [staff, assets] = await Promise.all([
      db(U.staff).find({ where: { $or: [{ staff_name: { $containsi: q } }, { staff_id: { $containsi: q } }] }, limit: 10, populate: { dept: true } }),
      db(U.asset).find({ where: { $or: [{ tag_number: { $containsi: q } }, { asset_name: { $containsi: q } }, { serial_number: { $containsi: q } }] }, limit: 10, populate: { assigned_to: true, last_access_point: true } }),
    ]);
    return { staff: clean(staff), assets: clean(assets) };
  },
};

async function addVisitorItems(ctx, visit, list, c) {
  const out = [];
  const valid = (list || []).filter((x) => x && (x.type || x.name));
  if (!valid.length) return out;
  const tags = await L.nextTags('VS-', valid.length, 4);
  for (let i = 0; i < valid.length; i++) {
    const x = valid[i];
    const a = await db(U.asset).create({ tag_number: x.sticker ? tags[i] : null, asset_name: x.type || x.name, description: x.make_model || x.description || null, serial_number: x.serial || null, ownership: 'visitor', visit: visit.id, asset_status: 'available', location_state: 'inside', last_access_point: c?.ap?.id || null, last_seen_at: new Date(), branch: c?.branchId || null, gate_rule: 'portable', approval_status: 'approved' });
    out.push({ id: a.id, tag: a.tag_number, name: a.asset_name, description: a.description, serial: a.serial_number });
  }
  return out;
}
module.exports.addVisitorItems = addVisitorItems;
