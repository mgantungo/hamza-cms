'use strict';
const crypto = require('crypto');
const L = require('../lib');
const { U, db } = L;
const { clean } = require('./resources');
const gate = require('./gate');

const NO_SHOW_HOURS = () => Number(L.env('NO_SHOW_HOURS', 2));
function dayRange(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const a = new Date(d); a.setHours(0, 0, 0, 0);
  const b = new Date(a); b.setDate(b.getDate() + 1);
  return [a, b];
}
function isSelfOnly(user) {
  return !L.hasRole(user, 'Reception') && !L.hasRole(user, 'Super Admin') && !L.hasRole(user, 'Branch Admin') && !L.hasRole(user, 'Security') && !L.hasRole(user, 'Security Supervisor');
}

module.exports = {
  async queue(ctx) {
    const user = ctx.state.appUser;
    const [a, b] = dayRange(ctx.query.date);
    // lazily mark no-shows
    const late = await db(U.appointment).find({ where: { status: 'booked', scheduled_at: { $lt: new Date(Date.now() - NO_SHOW_HOURS() * 3600e3) } } });
    for (const x of late) await db(U.appointment).update(x.id, { status: 'no_show' });

    const scope = L.branchWhere(user, 'branch');
    const visits = await db(U.visit).find({ where: { $and: [scope, { $or: [{ arrived_at: { $gte: a, $lt: b } }, { status: { $in: ['waiting', 'in_building'] } }] }] }, populate: { visitor: true, host: { populate: { dept: true } }, badge: true, appointment: true }, orderBy: { arrived_at: 'desc' } });
    const appts = await db(U.appointment).find({ where: { $and: [scope, { scheduled_at: { $gte: a, $lt: b } }] }, populate: { host: { populate: { dept: true } } }, orderBy: { scheduled_at: 'asc' } });
    const itemsByVisit = {};
    if (visits.length) {
      const items = await db(U.asset).find({ where: { visit: { id: { $in: visits.map((v) => v.id) } } }, populate: { visit: true } });
      for (const it of items) { const k = it.visit?.id; (itemsByVisit[k] = itemsByVisit[k] || []).push({ id: it.id, tag: it.tag_number, name: it.asset_name, description: it.description, serial: it.serial_number, location_state: it.location_state }); }
    }
    const badges = await db(U.badge).find({ where: scope });
    return {
      visits: clean(visits).map((v) => ({ ...v, items: itemsByVisit[v.id] || [] })),
      appointments: clean(appts),
      counts: {
        waiting: visits.filter((v) => v.status === 'waiting').length,
        in_building: visits.filter((v) => v.status === 'in_building').length,
        checked_out: visits.filter((v) => v.status === 'checked_out').length,
        expected: appts.filter((x) => x.status === 'booked').length,
        badges_out: badges.filter((x) => x.status === 'issued').length, badges_total: badges.length,
      },
    };
  },

  async walkIn(ctx) { return gate.registerVisitor(ctx); },

  async checkIn(ctx) {
    const { hostId, purpose, badgeNumber, notes, items = [], photo_url } = ctx.request.body || {};
    const visit = await db(U.visit).byId(ctx.params.id, { visitor: true, branch: true, appointment: true });
    if (!visit) return L.bad(ctx, 'Visit not found', 404);
    if (visit.status !== 'waiting') return L.bad(ctx, `Visitor is already ${visit.status.replace('_', ' ')}`, 409);
    if (!hostId) return L.bad(ctx, 'Choose the host from the staff list');
    if (!purpose) return L.bad(ctx, 'Purpose is required');
    let badge = null;
    if (badgeNumber) {
      badge = await db(U.badge).one({ where: { number: { $eqi: badgeNumber } } });
      if (!badge) return L.bad(ctx, `Badge ${badgeNumber} is not in the badge pool`);
      if (badge.status !== 'available') return L.bad(ctx, `Badge ${badge.number} is ${badge.status}`);
      await db(U.badge).update(badge.id, { status: 'issued' });
    }
    if (items.length) await gate.addVisitorItems(ctx, visit, items, { branchId: visit.branch?.id, ap: null });
    const row = await db(U.visit).update(visit.id, { host: hostId, purpose, notes: notes || null, badge: badge?.id || null, status: 'in_building', checked_in_at: new Date(), checked_in_by: ctx.state.appUser.username, photo_url: photo_url || null });
    const hosts = await db(U.user).find({ where: { staff: { id: hostId }, active: true } });
    await L.notify(hosts.map((h) => h.id), 'Your visitor has arrived', `${visit.visitor?.guest_name} is at reception (${purpose})`, '/me');
    await L.audit(ctx, 'check_in', 'visit', visit.id, null, { hostId, badge: badge?.number });
    return { data: clean(row) };
  },

  async decline(ctx) {
    const visit = await db(U.visit).byId(ctx.params.id);
    if (!visit) return L.bad(ctx, 'Visit not found', 404);
    await db(U.visit).update(visit.id, { status: 'declined', notes: ctx.request.body?.reason || visit.notes });
    await L.audit(ctx, 'decline', 'visit', visit.id, null, { reason: ctx.request.body?.reason });
    return { ok: true };
  },

  /** Staff book their own visitors; reception books for anyone. */
  async book(ctx) {
    const user = ctx.state.appUser;
    const b = ctx.request.body || {};
    if (!b.visitor_name || !b.phone || !b.scheduled_at || !b.purpose) return L.bad(ctx, 'Name, phone, date-time and purpose are required');
    let hostId = L.idOf(b.host);
    if (isSelfOnly(user)) {
      if (!user.staff) return L.bad(ctx, 'Your login is not linked to a staff record', 403);
      hostId = user.staff.id;
    }
    if (!hostId) return L.bad(ctx, 'Choose the host');
    const host = await db(U.staff).byId(hostId, { branch: true });
    const invite = 'INV-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 5);
    const row = await db(U.appointment).create({ visitor_name: b.visitor_name, organisation: b.organisation || null, phone: b.phone, email: b.email || null, id_type: b.id_type || null, id_number: b.id_number || null, host: hostId, branch: L.idOf(b.branch) || host?.branch?.id || null, scheduled_at: b.scheduled_at, duration_min: L.num(b.duration_min) || 60, purpose: b.purpose, agenda: b.agenda || null, plate: b.plate || null, devices_expected: b.devices_expected || null, group_size: L.num(b.group_size) || 1, invite_code: invite, status: 'booked', booked_by: user.username }, { host: true, branch: true });
    const hook = L.env('SMS_WEBHOOK_URL');
    if (hook) {
      try { await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: [{ phone: b.phone, email: b.email }], title: 'Visit invitation', body: `Your visit with ${host?.staff_name} on ${new Date(b.scheduled_at).toLocaleString('en-GB')}. Show code ${invite} at the gate.` }) }); } catch (e) { strapi.log.warn(e.message); }
    }
    await L.audit(ctx, 'book', 'appointment', row.id, null, { invite });
    return { data: clean(row) };
  },

  async cancel(ctx) {
    const row = await db(U.appointment).byId(ctx.params.id);
    if (!row) return L.bad(ctx, 'Not found', 404);
    const user = ctx.state.appUser;
    if (isSelfOnly(user) && row.booked_by !== user.username) return L.bad(ctx, 'You can cancel only your own bookings', 403);
    await db(U.appointment).update(row.id, { status: 'cancelled' });
    return { ok: true };
  },

  async mine(ctx) {
    const user = ctx.state.appUser;
    if (!user.staff) return { data: [] };
    const rows = await db(U.appointment).find({ where: { host: { id: user.staff.id }, scheduled_at: { $gte: new Date(Date.now() - 7 * 864e5) } }, orderBy: { scheduled_at: 'desc' }, limit: 50 });
    const visits = await db(U.visit).find({ where: { host: { id: user.staff.id }, status: { $in: ['waiting', 'in_building'] } }, populate: { visitor: true } });
    return { data: clean(rows), visitsNow: clean(visits) };
  },

  /** End-of-day job (cron and manual): overstays and unreturned badges. */
  async closeDay(ctx) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const open = await db(U.visit).find({ where: { status: 'in_building' }, populate: { visitor: true, badge: true, branch: true } });
    let n = 0;
    for (const v of open) {
      const exists = await db(U.case).one({ where: { visit: { id: v.id }, type: 'visitor_overstay' } });
      if (exists) continue;
      await L.openCase(ctx, { type: v.badge ? 'badge_not_returned' : 'visitor_overstay', severity: 'low', title: `Visitor still inside at close of day: ${v.visitor?.guest_name}`, description: v.badge ? `Badge ${v.badge.number} not returned` : '', visit: v.id, branch: v.branch?.id || null });
      n++;
    }
    return { casesOpened: n };
  },
};
