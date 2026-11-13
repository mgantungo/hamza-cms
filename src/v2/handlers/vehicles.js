'use strict';
/**
 * Vehicle gate. Vehicles are company assets in a category with is_vehicle = true; the plate is
 * kept in serial_number (upper case, no spaces). Movements go into the same movement log as items.
 * Guest vehicles use the passcard pool and guest-vehicle-session records.
 */
const L = require('../lib');
const { U, db } = L;
const { clean } = require('./resources');

const GVS = 'api::guest-vehicle-session.guest-vehicle-session';
const PASS = 'api::vehicle-passcard.vehicle-passcard';
const plateOf = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

async function context(ctx) {
  const t = await L.terminalFromCtx(ctx);
  let ap = t?.access_point || null;
  const id = ctx.request.body?.accessPointId || ctx.query.accessPointId;
  if (!ap && id) ap = await db(U.ap).byId(id, { branch: true });
  return { terminal: t, ap, branchId: ap?.branch?.id || null };
}
function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

/** QR payloads: {"assetId":"UBA123X","assetType":"vehicle","recordId":12} · VEHICLE|UBA123X · plain plate. */
function parseVehicleCode(raw) {
  const v = String(raw || '').trim();
  if (v.startsWith('{')) { try { const j = JSON.parse(v); if (j.assetType === 'vehicle') return { plate: plateOf(j.assetId), recordId: j.recordId || null }; } catch { /* not json */ } }
  const parts = v.split('|');
  if (parts[0]?.toUpperCase() === 'VEHICLE' && parts[1]) return { plate: plateOf(parts[1]), recordId: null };
  return null;
}

async function findVehicle(code) {
  const parsed = parseVehicleCode(code);
  const plate = parsed?.plate || plateOf(code);
  const where = parsed?.recordId ? { id: parsed.recordId } : { $or: [{ serial_number: { $eqi: plate } }, { tag_number: { $eqi: plate } }, { tag_number: { $eqi: String(code).trim() } }] };
  const v = await db(U.asset).one({ where: { ...where, category_ref: { is_vehicle: true } }, populate: { assigned_to: { populate: { dept: true } }, category_ref: true, last_access_point: { populate: { branch: true } }, branch: true } });
  return { vehicle: v, plate, isQr: !!parsed };
}

function nextDirection(v, branchId) {
  // a vehicle can stay on site for days: direction comes only from its last known state
  if (v.location_state === 'inside' && (!v.last_access_point?.branch || v.last_access_point.branch.id === branchId)) return 'OUT';
  return 'IN';
}
function shapeVehicle(v, branchId) {
  return { id: v.id, tag: v.tag_number, plate: v.serial_number || v.tag_number, name: v.asset_name, make: v.make, model: v.model, status: v.asset_status, location_state: v.location_state, last_seen_at: v.last_seen_at, last_gate: v.last_access_point?.name || null, driver: v.assigned_to ? { id: v.assigned_to.id, name: v.assigned_to.staff_name, staff_id: v.assigned_to.staff_id, department: v.assigned_to.dept?.name || v.assigned_to.department } : null, next: nextDirection(v, branchId) };
}

module.exports = {
  parseVehicleCode, plateOf,

  /** What was scanned at the vehicle gate: a vehicle, a driver card, a passcard, an invite. */
  async identify(ctx) {
    const code = String(ctx.request.body?.code || '').trim();
    if (!code) return L.bad(ctx, 'Nothing scanned');
    const c = await context(ctx);

    const { vehicle, plate, isQr } = await findVehicle(code);
    if (vehicle) return { type: 'vehicle', vehicle: shapeVehicle(vehicle, c.branchId), method: isQr ? 'QR scan' : 'Manual entry' };

    const staff = await db(U.staff).one({ where: { $or: [{ card_number: { $eqi: code } }, { staff_id: { $eqi: code } }, { national_id: code }] }, populate: { dept: true } });
    if (staff) {
      const drives = await db(U.asset).find({ where: { assigned_to: { id: staff.id }, category_ref: { is_vehicle: true }, asset_status: { $ne: 'decommissioned' } } });
      return { type: 'staff', staff: { id: staff.id, staff_id: staff.staff_id, card: staff.card_number, name: staff.staff_name, department: staff.dept?.name || staff.department, status: staff.status, photo_url: staff.photo_url }, vehicles: drives.map((d) => ({ id: d.id, plate: d.serial_number || d.tag_number, name: d.asset_name })) };
    }

    const pass = await db(PASS).one({ where: { passcard_number: { $eqi: code } } });
    if (pass) {
      const session = await db(GVS).one({ where: { passcard: { id: pass.id }, session_status: 'checked_in' }, populate: { passcard: true }, orderBy: { id: 'desc' } });
      return { type: 'passcard', passcard: clean(pass), session: session ? clean(session) : null };
    }

    if (/^INV-/i.test(code)) {
      const ap = await db(U.appointment).one({ where: { invite_code: { $eqi: code } }, populate: { host: true } });
      if (ap) return { type: 'appointment', appointment: clean(ap) };
    }

    // a plate typed by hand that is not a company vehicle: guest vehicle in or out?
    const active = await db(GVS).one({ where: { plate_number: { $eqi: plate }, session_status: 'checked_in' }, populate: { passcard: true }, orderBy: { id: 'desc' } });
    if (active) return { type: 'guest_vehicle_inside', session: clean(active) };
    const today = startOfDay(); const tomorrow = new Date(today.getTime() + 864e5);
    const expected = await db(U.appointment).one({ where: { plate: { $eqi: plate }, status: { $in: ['booked', 'arrived'] }, scheduled_at: { $gte: today, $lt: tomorrow } }, populate: { host: true } });
    return L.bad(ctx, expected ? `Not a company vehicle — expected visitor ${expected.visitor_name}. Press F4 to check it in.` : `${plate} is not a registered vehicle. Press F4 for a guest vehicle.`, 404);
  },

  /** Vehicle + driver both known → one movement. Rules raise a full-screen exception and a case. */
  async record(ctx) {
    const { vehicleId, staffId, method, direction: forced } = ctx.request.body || {};
    const c = await context(ctx);
    if (!c.ap) return L.bad(ctx, 'This PC is not enrolled to an access point', 412);
    const v = await db(U.asset).byId(vehicleId, { assigned_to: { populate: { dept: true } }, category_ref: true, last_access_point: { populate: { branch: true } } });
    if (!v || !v.category_ref?.is_vehicle) return L.bad(ctx, 'Vehicle not found', 404);
    const driver = staffId ? await db(U.staff).byId(staffId, { dept: true }) : null;
    if (!driver) return L.bad(ctx, 'Scan the driver\'s card', 400);
    const direction = forced || nextDirection(v, c.branchId);

    let exception = null;
    if (v.asset_status === 'lost') exception = { type: 'lost_scanned', severity: 'critical', reason: 'Vehicle reported lost or stolen' };
    else if (v.asset_status === 'decommissioned') exception = { type: 'decommissioned_at_gate', severity: 'high', reason: 'Decommissioned vehicle' };
    else if (driver.status && driver.status !== 'active') exception = { type: 'driver_blocked', severity: 'high', reason: `Driver is ${driver.status}` };
    else if (v.assigned_to && v.assigned_to.id !== driver.id) exception = { type: 'vehicle_driver_mismatch', severity: 'high', reason: 'Driver is not assigned to this vehicle' };

    const now = new Date();
    let caseRow = null;
    if (exception) {
      if (exception.type === 'lost_scanned') {
        caseRow = await db(U.case).one({ where: { asset: { id: v.id }, status: { $notIn: ['resolved', 'closed'] } }, orderBy: { id: 'desc' } });
        if (caseRow) await L.addCaseNote(caseRow.id, ctx.state.appUser.username, `SCANNED at ${c.ap.name} driven by ${driver.staff_name}`, 'gate');
      }
      if (!caseRow) caseRow = await L.openCase(ctx, { type: exception.type, severity: exception.severity, title: `${exception.reason}: ${v.serial_number || v.tag_number}`, description: `${direction} at ${c.ap.name}, driver ${driver.staff_name}${v.assigned_to ? `; assigned to ${v.assigned_to.staff_name}` : ''}`, asset: v.id, staff: driver.id, branch: c.branchId, access_point: c.ap.id });
    }
    const mv = await db(U.movement).create({ asset: v.id, person: driver.id, direction, access_point: c.ap.id, branch: c.branchId, terminal: c.terminal?.id || null, guard: ctx.state.appUser.username, result: exception ? 'exception' : 'ok', reason: exception?.reason || null, investigation: caseRow?.id || null, scanned_at: now, method: method === 'Manual entry' ? 'manual' : 'scan' });
    await db(U.asset).update(v.id, { location_state: direction === 'IN' ? 'inside' : 'outside', last_access_point: c.ap.id, last_seen_at: now });
    return {
      movementId: mv.id, direction, result: exception ? 'exception' : 'ok',
      exception: exception ? { ...exception, caseId: caseRow?.id, caseNumber: caseRow?.number } : null,
      vehicle: { id: v.id, plate: v.serial_number || v.tag_number, name: v.asset_name, assignedTo: v.assigned_to?.staff_name || null },
      driver: { id: driver.id, name: driver.staff_name },
    };
  },

  /** Today at this access point: vehicle movements + guest vehicles + expected visitor plates. */
  async today(ctx) {
    const c = await context(ctx);
    const day = startOfDay(); const tomorrow = new Date(day.getTime() + 864e5);
    const mv = await db(U.movement).find({ where: { scanned_at: { $gte: day }, asset: { category_ref: { is_vehicle: true } }, ...(c.ap ? { access_point: { id: c.ap.id } } : {}) }, populate: { asset: true, person: { populate: { dept: true } }, access_point: true }, orderBy: { scanned_at: 'desc' }, limit: 300 });
    const guests = await db(GVS).find({ where: { $or: [{ check_in_time: { $gte: day } }, { check_out_time: { $gte: day } }, { session_status: 'checked_in' }] }, populate: { passcard: true }, orderBy: { id: 'desc' }, limit: 200 });
    const rows = [
      ...mv.map((m) => ({ key: `m${m.id}`, at: m.scanned_at, plate: m.asset?.serial_number || m.asset?.tag_number, vehicle: m.asset?.asset_name, driver: m.person?.staff_name, department: m.person?.dept?.name || m.person?.department, direction: m.direction, result: m.result, reason: m.reason, kind: 'company', method: m.method })),
      ...guests.flatMap((g) => [
        g.check_in_time && new Date(g.check_in_time) >= day ? { key: `gi${g.id}`, at: g.check_in_time, plate: g.plate_number, vehicle: `Guest · ${g.purpose || ''}`, driver: g.visitor_name, department: 'Visitor', direction: 'IN', result: 'ok', kind: 'guest', passcard: g.passcard?.passcard_number } : null,
        g.check_out_time && new Date(g.check_out_time) >= day ? { key: `go${g.id}`, at: g.check_out_time, plate: g.plate_number, vehicle: `Guest · ${g.purpose || ''}`, driver: g.visitor_name, department: 'Visitor', direction: 'OUT', result: 'ok', kind: 'guest', passcard: g.passcard?.passcard_number } : null,
      ].filter(Boolean)),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    const onSite = await db(U.asset).raw.count({ where: { category_ref: { is_vehicle: true }, location_state: 'inside' } });
    const guestsInside = guests.filter((g) => g.session_status === 'checked_in').length;
    const expected = await db(U.appointment).find({ where: { plate: { $notNull: true, $ne: '' }, status: 'booked', scheduled_at: { $gte: day, $lt: tomorrow } }, populate: { host: true }, orderBy: { scheduled_at: 'asc' } });
    return {
      counts: { in: rows.filter((r) => r.direction === 'IN').length, out: rows.filter((r) => r.direction === 'OUT').length, exceptions: rows.filter((r) => r.result === 'exception').length, onSite, guestsInside },
      rows, expected: clean(expected), guestsInside: clean(guests.filter((g) => g.session_status === 'checked_in')),
    };
  },

  async guestIn(ctx) {
    const b = ctx.request.body || {};
    const c = await context(ctx);
    const plate = plateOf(b.plate);
    if (!plate) return L.bad(ctx, 'Plate number is required');
    if (!b.visitor_name) return L.bad(ctx, 'Driver / visitor name is required');
    const pass = await db(PASS).one({ where: { passcard_number: { $eqi: String(b.passcard || '').trim() } } });
    if (!pass) return L.bad(ctx, `${b.passcard || 'That'} is not a registered passcard`);
    if (pass.passcard_status !== 'available') return L.bad(ctx, `Passcard ${pass.passcard_number} is ${pass.passcard_status}`, 409);
    const inside = await db(GVS).one({ where: { plate_number: { $eqi: plate }, session_status: 'checked_in' } });
    if (inside) return L.bad(ctx, `${plate} is already checked in`, 409);
    const company = await db(U.asset).one({ where: { serial_number: { $eqi: plate }, category_ref: { is_vehicle: true } } });
    if (company) return L.bad(ctx, `${plate} is a company vehicle — scan it with the driver's card instead`, 409);
    const appt = b.appointmentId ? await db(U.appointment).byId(b.appointmentId) : null;
    const s = await db(GVS).create({ plate_number: plate, visitor_name: b.visitor_name, phone: b.phone || null, purpose: ['Pickup', 'Delivery', 'Other'].includes(b.purpose) ? b.purpose : 'Other', passcard: pass.id, session_status: 'checked_in', location: c.ap?.name || null, access_point: c.ap?.id || null, branch: c.branchId, appointment: appt?.id || null, check_in_time: new Date(), registered_by: ctx.state.appUser.username });
    await db(PASS).update(pass.id, { passcard_status: 'issued' });
    if (appt && appt.status === 'booked') await db(U.appointment).update(appt.id, { status: 'arrived' });
    await L.audit(ctx, 'guest_vehicle_in', 'guest-vehicle-session', s.id, null, { plate, passcard: pass.passcard_number });
    return { session: clean(s), passcard: pass.passcard_number };
  },

  async guestOut(ctx) {
    const b = ctx.request.body || {};
    const c = await context(ctx);
    let s = null;
    if (b.sessionId) s = await db(GVS).byId(b.sessionId, { passcard: true });
    else if (b.passcard) { const p = await db(PASS).one({ where: { passcard_number: { $eqi: String(b.passcard).trim() } } }); if (p) s = await db(GVS).one({ where: { passcard: { id: p.id }, session_status: 'checked_in' }, populate: { passcard: true } }); }
    else if (b.plate) s = await db(GVS).one({ where: { plate_number: { $eqi: plateOf(b.plate) }, session_status: 'checked_in' }, populate: { passcard: true } });
    if (!s || s.session_status !== 'checked_in') return L.bad(ctx, 'No guest vehicle is checked in with that passcard or plate', 404);
    await db(GVS).update(s.id, { session_status: 'checked_out', check_out_time: new Date(), access_point_out: c.ap?.id || null, checked_out_by: ctx.state.appUser.username });
    if (s.passcard) await db(PASS).update(s.passcard.id, { passcard_status: b.passcardLost ? 'lost' : 'available' });
    if (b.passcardLost) await L.openCase(ctx, { type: 'badge_not_returned', severity: 'low', title: `Vehicle passcard ${s.passcard?.passcard_number} not returned by ${s.visitor_name} (${s.plate_number})`, branch: c.branchId, access_point: c.ap?.id || null });
    await L.audit(ctx, 'guest_vehicle_out', 'guest-vehicle-session', s.id);
    return { ok: true, plate: s.plate_number, visitor: s.visitor_name };
  },

  /** Fleet list for the vehicle admin screen. */
  async fleet(ctx) {
    const user = ctx.state.appUser;
    const where = { $and: [{ category_ref: { is_vehicle: true } }, L.branchWhere(user)] };
    if (ctx.query.status) where.$and.push({ asset_status: ctx.query.status });
    if (ctx.query.q) where.$and.push({ $or: [{ serial_number: { $containsi: ctx.query.q } }, { tag_number: { $containsi: ctx.query.q } }, { asset_name: { $containsi: ctx.query.q } }, { assigned_to: { staff_name: { $containsi: ctx.query.q } } }] });
    const rows = await db(U.asset).find({ where, populate: { assigned_to: { populate: { dept: true } }, last_access_point: true, branch: true }, orderBy: { serial_number: 'asc' }, limit: 1000 });
    const all = await db(U.asset).find({ where: { $and: [{ category_ref: { is_vehicle: true } }, L.branchWhere(user)] }, select: ['asset_status', 'location_state'] });
    return {
      data: clean(rows),
      counts: { total: all.length, assigned: all.filter((x) => x.asset_status === 'assigned').length, available: all.filter((x) => x.asset_status === 'available').length, onSite: all.filter((x) => x.location_state === 'inside' && x.asset_status !== 'decommissioned').length, out: all.filter((x) => x.location_state === 'outside' && x.asset_status !== 'decommissioned').length, decommissioned: all.filter((x) => x.asset_status === 'decommissioned').length },
    };
  },
};
