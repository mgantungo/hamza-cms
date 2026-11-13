'use strict';
const crypto = require('crypto');
const L = require('../lib');
const { U, db } = L;

async function startShift(user, terminal) {
  if (!terminal || !L.can(user, 'gate', 'create')) return null;
  const ap = terminal.access_point;
  return db(U.shift).create({ guard_name: user.full_name, shift_type: 'login', entrance: ap?.name || '', start_time: new Date(), active: true, user: user.id, access_point: ap?.id || null, terminal: terminal.id });
}
async function endShifts(userId) {
  const open = await db(U.shift).find({ where: { user: { id: userId }, active: true } });
  for (const s of open) await db(U.shift).update(s.id, { active: false, end_time: new Date() });
}

function allowedAt(user, terminal) {
  if (!terminal) return true;
  if (user.allBranches) return true;
  const ap = terminal.access_point;
  if (!ap) return false;
  // a guard must be assigned to this access point when their only gate rights are access-point scoped
  if (user.roleScopes.every((s) => s === 'access_points' || s === 'self')) return user.accessPointIds.includes(ap.id);
  return user.branchIds.includes(ap.branch?.id) || user.accessPointIds.includes(ap.id);
}

function terminalInfo(t) {
  if (!t) return null;
  return { id: t.id, name: t.name, accessPoint: t.access_point ? { id: t.access_point.id, name: t.access_point.name, kind: t.access_point.kind, legacy_location: t.access_point.legacy_location } : null, branch: t.access_point?.branch ? { id: t.access_point.branch.id, name: t.access_point.branch.name } : null };
}

module.exports = {
  terminalInfo,

  async login(ctx) {
    const { username, password, cardCode, pin } = ctx.request.body || {};
    let raw;
    if (cardCode) {
      const staff = await db(U.staff).one({ where: { $or: [{ card_number: { $eqi: cardCode } }, { staff_id: { $eqi: cardCode } }] } });
      raw = staff ? await db(U.user).one({ where: { staff: { id: staff.id }, active: true } }) : null;
      if (!raw || !L.checkPw(pin, raw.pin_hash)) return L.bad(ctx, 'Card or PIN not recognised', 401);
    } else {
      raw = await db(U.user).one({ where: { username: { $eqi: String(username || '').trim() } } });
      if (!raw || raw.active === false || !L.checkPw(password, raw.password_hash)) return L.bad(ctx, 'Wrong username or password', 401);
    }
    const user = await L.loadUser(raw.id, true);
    const terminal = await L.terminalFromCtx(ctx);
    if (terminal && !L.can(user, 'gate', 'view') && !L.can(user, 'reception', 'view') && !L.can(user, 'admin', 'view')) return L.bad(ctx, 'This PC is a gate terminal. Sign in on your own computer.', 403);
    if (terminal && !allowedAt(user, terminal)) return L.bad(ctx, `You are not assigned to ${terminal.access_point?.name || 'this access point'}`, 403);
    await db(U.user).update(raw.id, { last_login: new Date() });
    if (terminal) {
      await db(U.terminal).update(terminal.id, { last_seen: new Date(), last_user: user.username });
      await startShift(user, terminal);
    }
    ctx.state.appUser = user;
    await L.audit(ctx, 'login', 'app-user', user.id, null, { terminal: terminal?.name || null });
    return { jwt: L.sign(user), user, terminal: terminalInfo(terminal) };
  },

  async me(ctx) {
    const terminal = await L.terminalFromCtx(ctx);
    return { user: ctx.state.appUser, terminal: terminalInfo(terminal) };
  },

  async logout(ctx) {
    await endShifts(ctx.state.appUser.id);
    await L.audit(ctx, 'logout', 'app-user', ctx.state.appUser.id);
    return { ok: true };
  },

  async changePassword(ctx) {
    const { current, next, pin } = ctx.request.body || {};
    const raw = await db(U.user).byId(ctx.state.appUser.id);
    if (!L.checkPw(current, raw.password_hash)) return L.bad(ctx, 'Current password is wrong', 400);
    const data = {};
    if (next) { if (String(next).length < 8) return L.bad(ctx, 'Use at least 8 characters'); data.password_hash = L.hash(next); }
    if (pin) { if (!/^\d{4,6}$/.test(String(pin))) return L.bad(ctx, 'PIN must be 4–6 digits'); data.pin_hash = L.hash(pin); }
    await db(U.user).update(raw.id, data);
    return { ok: true };
  },

  // ------------------------------------------------ terminals
  /** Public: called by the Nuxt server with the device's token. Renews last_seen. */
  async resolveTerminal(ctx) {
    const t = await L.terminalFromCtx(ctx);
    if (!t) return L.bad(ctx, 'Terminal not enrolled', 404);
    await db(U.terminal).update(t.id, { last_seen: new Date() });
    return { terminal: terminalInfo(t) };
  },

  /** Public endpoint but requires admin credentials in the body (guards cannot enrol). */
  async enrol(ctx) {
    const { username, password, accessPointId, name, step } = ctx.request.body || {};
    const raw = await db(U.user).one({ where: { username: { $eqi: String(username || '').trim() } } });
    if (!raw || !L.checkPw(password, raw.password_hash)) return L.bad(ctx, 'Wrong administrator username or password', 401);
    const admin = await L.loadUser(raw.id, true);
    if (!L.can(admin, 'admin', 'edit')) return L.bad(ctx, 'Only an administrator can enrol a terminal', 403);
    if (step === 'check') {
      // return the access points this admin may enrol into
      const where = admin.allBranches ? { active: true } : { active: true, branch: { id: { $in: admin.branchIds.length ? admin.branchIds : [-1] } } };
      const aps = await db(U.ap).find({ where, populate: { branch: true }, orderBy: { name: 'asc' } });
      return { admin: { username: admin.username, full_name: admin.full_name, roles: admin.roles }, accessPoints: aps.map((a) => ({ id: a.id, name: a.name, kind: a.kind, branch: a.branch ? { id: a.branch.id, name: a.branch.name } : null })) };
    }
    const ap = await db(U.ap).byId(accessPointId, { branch: true });
    if (!ap) return L.bad(ctx, 'Pick an access point');
    if (!admin.allBranches && !admin.branchIds.includes(ap.branch?.id)) return L.bad(ctx, 'You do not manage that branch', 403);
    const token = crypto.randomBytes(32).toString('hex');
    const t = await db(U.terminal).create({ name: name || `${ap.name} PC`, token_hash: L.sha256(token), access_point: ap.id, last_seen: new Date(), enrolled_by: admin.username, revoked: false }, { access_point: { populate: { branch: true } } });
    ctx.state.appUser = admin;
    await L.audit(ctx, 'enrol', 'terminal', t.id, null, { name: t.name, access_point: ap.name });
    return { token, terminal: terminalInfo(t) };
  },

  // ------------------------------------------------ notifications
  async myNotifications(ctx) {
    const rows = await db(U.notif).find({ where: { user: { id: ctx.state.appUser.id } }, orderBy: { at: 'desc' }, limit: 30 });
    return { data: rows, unread: rows.filter((r) => !r.read).length };
  },
  async readNotifications(ctx) {
    const rows = await db(U.notif).find({ where: { user: { id: ctx.state.appUser.id }, read: false } });
    for (const r of rows) await db(U.notif).update(r.id, { read: true });
    return { ok: true };
  },
};
