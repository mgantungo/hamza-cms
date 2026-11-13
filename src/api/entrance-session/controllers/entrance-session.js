'use strict';

const { factories } = require('@strapi/strapi');

function toFrontendShape(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    status: entry.session_status,
  };
}

async function resolveStaffRelation(strapi, staffId) {
  if (!staffId) return null;
  const matches = await strapi.documents('api::staff.staff').findMany({
    filters: { staff_id: staffId },
  });
  if (!matches.length) throw new Error(`Staff ${staffId} not found`);
  return matches[0].documentId;
}

async function resolveGuestRelation(strapi, guestNin) {
  if (!guestNin) return null;
  const matches = await strapi.documents('api::guest.guest').findMany({
    filters: { nin: guestNin },
  });
  if (!matches.length) throw new Error(`Guest ${guestNin} not found`);
  return matches[0].documentId;
}

function remapBody(body) {
  if (body.status !== undefined) {
    body.session_status = body.status;
    delete body.status;
  }
  return body;
}

async function resolveDocumentId(strapi, idParam) {
  // If it's purely numeric, treat as legacy numeric id and resolve to documentId
  if (/^\d+$/.test(String(idParam))) {
    const entry = await strapi.db.query('api::entrance-session.entrance-session').findOne({
      where: { id: idParam },
    });
    if (!entry) return null;
    return entry.documentId;
  }
  return idParam; // already a documentId
}

module.exports = factories.createCoreController('api::entrance-session.entrance-session', ({ strapi }) => ({
  async byEntrance(ctx) {
    const { entrance } = ctx.params;
    const { status } = ctx.query;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const filters = { entrance, createdAt: { $gte: startOfDay.toISOString() } };
    if (status) filters.session_status = status;

    const entries = await strapi.documents('api::entrance-session.entrance-session').findMany({
      filters,
      populate: { staff: true, guest: true },
      sort: { createdAt: 'desc' },
    });

    return { data: entries.map(toFrontendShape) };
  },
  async find(ctx) {
    ctx.query = { ...ctx.query, populate: { staff: true, guest: true, ...(ctx.query.populate || {}) } };
    const { data, meta } = await super.find(ctx);
    return { data: data.map(toFrontendShape), meta };
  },

  async create(ctx) {
    let body = ctx.request.body.data || ctx.request.body || {};
    body = remapBody(body);

    if (body.staff !== undefined && typeof body.staff === 'string') {
      body.staff = await resolveStaffRelation(strapi, body.staff);
    }
    if (body.guest !== undefined && typeof body.guest === 'string') {
      body.guest = await resolveGuestRelation(strapi, body.guest);
    }

    ctx.request.body.data = body;
    const result = await super.create(ctx);
    if (result?.data) result.data = toFrontendShape(result.data);
    return result;
  },

  async update(ctx) {
    const resolvedId = await resolveDocumentId(strapi, ctx.params.id);
    if (!resolvedId) return ctx.notFound('Entrance session not found');
    ctx.params.id = resolvedId;

    let body = ctx.request.body.data || ctx.request.body || {};
    body = remapBody(body);

    if (body.staff !== undefined && typeof body.staff === 'string') {
      body.staff = await resolveStaffRelation(strapi, body.staff);
    }
    if (body.guest !== undefined && typeof body.guest === 'string') {
      body.guest = await resolveGuestRelation(strapi, body.guest);
    }

    // Mirror purpose into visitor_data so existing frontend read path (vd.purpose) works
    if (body.purpose !== undefined) {
      const existing = await strapi.db.query('api::entrance-session.entrance-session').findOne({
        where: { documentId: resolvedId },
      });
      const existingVisitorData = existing?.visitor_data || {};
      body.visitor_data = { ...existingVisitorData, purpose: body.purpose };
    }

    ctx.request.body.data = body;
    const result = await super.update(ctx);
    if (result?.data) result.data = toFrontendShape(result.data);
    return result;
  },
  async activeByGuest(ctx) {
    const { nin } = ctx.params;
    const entries = await strapi.documents('api::entrance-session.entrance-session').findMany({
      filters: {
        guest: { nin },
        session_status: 'checked_in',
      },
      populate: { guest: true },
      sort: { createdAt: 'desc' },
    });
    if (!entries.length) return ctx.notFound('No active check-in found for this guest');
    return toFrontendShape(entries[0]);
  },


}));