'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('../lib');
const { U, db } = L;
const { clean } = require('./resources');

const POP = { asset: { populate: { assigned_to: true, category_ref: true } }, staff: { populate: { dept: true } }, visit: { populate: { visitor: true, host: true } }, investigator: true, branch: true, access_point: true };
const WRITE_OFF_DAYS = () => Number(L.env('WRITE_OFF_DAYS', 30));

module.exports = {
  async get(ctx) {
    const c = await db(U.case).byId(ctx.params.id, POP);
    if (!c) return L.bad(ctx, 'Not found', 404);
    // timeline = notes + the asset's movements and history around the case
    const timeline = (c.notes || []).map((n) => ({ at: n.at, kind: n.kind || 'note', by: n.by, text: n.text }));
    if (c.asset) {
      const since = new Date(new Date(c.createdAt).getTime() - 14 * 864e5);
      const moves = await db(U.movement).find({ where: { asset: { id: c.asset.id }, scanned_at: { $gte: since } }, populate: { person: true, access_point: true }, orderBy: { scanned_at: 'desc' }, limit: 40 });
      moves.forEach((m) => timeline.push({ at: m.scanned_at, kind: 'gate', by: m.guard, text: `${m.direction} at ${m.access_point?.name || '?'}${m.person ? `, carried by ${m.person.staff_name}` : ''}${m.result === 'exception' ? ` — exception: ${m.reason}` : ''}` }));
      const hist = await db(U.history).find({ where: { company_asset: { id: c.asset.id }, event_date: { $gte: since } }, orderBy: { event_date: 'desc' }, limit: 40 });
      hist.forEach((h) => timeline.push({ at: h.event_date, kind: 'system', by: h.performed_by, text: `${h.action_type}${h.new_assignee ? ` → ${h.new_assignee}` : ''}${h.reason ? `: ${h.reason}` : ''}` }));
    }
    timeline.push({ at: c.createdAt, kind: 'system', by: c.opened_by, text: `Case opened (${c.type.replace(/_/g, ' ')}, ${c.severity})` });
    timeline.sort((a, b) => new Date(b.at) - new Date(a.at));
    return { data: clean(c), timeline };
  },

  async create(ctx) {
    const b = ctx.request.body || {};
    if (!b.title) return L.bad(ctx, 'Give the case a title');
    const c = await L.openCase(ctx, { type: 'manual', severity: b.severity || 'medium', title: b.title, description: b.description || null, asset: L.idOf(b.asset) || null, staff: L.idOf(b.staff) || null, branch: L.idOf(b.branch) || (ctx.state.appUser.branchIds[0] || null) });
    return { data: clean(c) };
  },

  async update(ctx) {
    const c = await db(U.case).byId(ctx.params.id);
    if (!c) return L.bad(ctx, 'Not found', 404);
    const b = ctx.request.body || {};
    const data = {};
    for (const k of ['severity', 'police_ref', 'insurance_ref', 'due_at', 'title', 'description']) if (b[k] !== undefined) data[k] = b[k] || null;
    if (b.investigator !== undefined) data.investigator = L.idOf(b.investigator) || null;
    if (b.status) {
      if (b.status === 'closed' && !(L.hasRole(ctx.state.appUser, 'Security Supervisor') || L.hasRole(ctx.state.appUser, 'Branch Admin') || L.hasRole(ctx.state.appUser, 'Super Admin'))) return L.bad(ctx, 'Only a Security Supervisor or admin can close a case', 403);
      data.status = b.status;
      if (['resolved', 'closed'].includes(b.status)) data.closed_at = new Date();
    }
    if (data.investigator && data.investigator !== c.investigator?.id) {
      if (!data.status && c.status === 'new') data.status = 'investigating';
      await L.notify([data.investigator], `${c.number} assigned to you`, c.title, `/security/investigations/${c.id}`);
    }
    await db(U.case).update(c.id, data);
    await L.addCaseNote(c.id, ctx.state.appUser.username, `Updated: ${Object.keys(data).join(', ')}`, 'system');
    await L.audit(ctx, 'update', 'investigation', c.id, null, data);
    return module.exports.get(ctx);
  },

  async note(ctx) {
    const text = String(ctx.request.body?.text || '').trim();
    if (!text) return L.bad(ctx, 'Write a note');
    await L.addCaseNote(ctx.params.id, ctx.state.appUser.username, text, 'note');
    return module.exports.get(ctx);
  },

  /** Multipart upload: field "file". Stored under public/uploads/evidence. */
  async evidence(ctx) {
    const c = await db(U.case).byId(ctx.params.id);
    if (!c) return L.bad(ctx, 'Not found', 404);
    const f = ctx.request.files?.file;
    const file = Array.isArray(f) ? f[0] : f;
    if (!file) return L.bad(ctx, 'Attach a file');
    const dir = path.join(strapi.dirs.static.public, 'uploads', 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(file.originalFilename || file.name || '').slice(0, 10);
    const name = `${c.number}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.copyFileSync(file.filepath || file.path, path.join(dir, name));
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    ev.push({ name: file.originalFilename || file.name, url: `/uploads/evidence/${name}`, by: ctx.state.appUser.username, at: new Date().toISOString() });
    await db(U.case).update(c.id, { evidence: ev });
    await L.addCaseNote(c.id, ctx.state.appUser.username, `Evidence attached: ${file.originalFilename || file.name}`, 'system');
    return module.exports.get(ctx);
  },

  /** found | recovered_damaged | hr_referral | insurance_claim | no_issue | written_off (proposal) */
  async outcome(ctx) {
    const c = await db(U.case).byId(ctx.params.id, { asset: true });
    if (!c) return L.bad(ctx, 'Not found', 404);
    const { outcome, notes } = ctx.request.body || {};
    const user = ctx.state.appUser;
    const a = c.asset;
    if (outcome === 'written_off') {
      if (c.type === 'lost_reported' && Date.now() - new Date(c.createdAt).getTime() < WRITE_OFF_DAYS() * 864e5 && !L.hasRole(user, 'Super Admin')) {
        return L.bad(ctx, `A write-off can be proposed ${WRITE_OFF_DAYS()} days after the loss was reported`);
      }
      await db(U.case).update(c.id, { write_off_status: 'proposed', outcome_notes: notes || null, status: 'awaiting_info' });
      await L.addCaseNote(c.id, user.username, `Write-off proposed${notes ? `: ${notes}` : ''}`, 'system');
      const admins = await L.usersWithRole('Branch Admin', { branch: c.branch?.id });
      await L.notify(admins.map((x) => x.id), `${c.number}: write-off needs approval`, c.title, `/security/investigations/${c.id}`);
      return module.exports.get(ctx);
    }
    if (a) {
      if (outcome === 'found') {
        const st = a.assigned_to ? 'assigned' : (a.previous_status && !['lost', 'decommissioned'].includes(a.previous_status) ? a.previous_status : 'available');
        await db(U.asset).update(a.id, { asset_status: st });
        await L.history(ctx, a.id, 'found', { notes: `Case ${c.number}` });
      } else if (outcome === 'recovered_damaged') {
        await db(U.asset).update(a.id, { asset_status: 'in_repair' });
        await L.history(ctx, a.id, 'repair', { notes: `Recovered damaged, case ${c.number}` });
      }
    }
    await db(U.case).update(c.id, { outcome, outcome_notes: notes || null, status: 'resolved', closed_at: new Date() });
    await L.addCaseNote(c.id, user.username, `Outcome: ${String(outcome).replace(/_/g, ' ')}${notes ? ` — ${notes}` : ''}`, 'system');
    await L.audit(ctx, 'outcome', 'investigation', c.id, null, { outcome });
    return module.exports.get(ctx);
  },

  async decideWriteOff(ctx) {
    const c = await db(U.case).byId(ctx.params.id, { asset: true });
    if (!c || c.write_off_status !== 'proposed') return L.bad(ctx, 'No write-off waiting on this case', 409);
    const approve = ctx.request.body?.approve !== false;
    if (approve && c.asset) {
      await db(U.asset).update(c.asset.id, { asset_status: 'decommissioned', previous_status: c.asset.asset_status });
      await L.history(ctx, c.asset.id, 'decommission', { reason: 'lost', notes: `Written off, case ${c.number}`, extra: { cost: c.asset.cost } });
    }
    await db(U.case).update(c.id, approve ? { write_off_status: 'approved', outcome: 'written_off', status: 'closed', closed_at: new Date() } : { write_off_status: 'rejected', status: 'investigating' });
    await L.addCaseNote(c.id, ctx.state.appUser.username, approve ? 'Write-off approved; asset decommissioned (reason: lost)' : `Write-off rejected${ctx.request.body?.reason ? `: ${ctx.request.body.reason}` : ''}`, 'system');
    await L.audit(ctx, approve ? 'approve_write_off' : 'reject_write_off', 'investigation', c.id);
    return module.exports.get(ctx);
  },
};
