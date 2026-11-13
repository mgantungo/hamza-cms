'use strict';

const { factories } = require('@strapi/strapi');

function toFrontendShape(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    status: entry.investigationStatus === 'resolved' ? 'resolved' : 'open',
  };
}

async function resolveDocumentId(strapi, idParam) {
  if (/^\d+$/.test(String(idParam))) {
    const entry = await strapi.db.query('api::anomaly.anomaly').findOne({
      where: { id: idParam },
    });
    if (!entry) return null;
    return entry.documentId;
  }
  return idParam;
}

module.exports = factories.createCoreController('api::anomaly.anomaly', ({ strapi }) => ({
  async all(ctx) {
    const entries = await strapi.documents('api::anomaly.anomaly').findMany({
      sort: { timestamp: 'desc' },
    });
    return { data: entries.map(toFrontendShape) };
  },

  async create(ctx) {
    const body = ctx.request.body.data || ctx.request.body || {};
    ctx.request.body.data = body;
    return super.create(ctx);
  },

  async resolve(ctx) {
    const resolvedId = await resolveDocumentId(strapi, ctx.params.id);
    if (!resolvedId) return ctx.notFound('Anomaly not found');

    const { notes } = ctx.request.body || {};

    const updated = await strapi.documents('api::anomaly.anomaly').update({
      documentId: resolvedId,
      data: {
        reviewed: true,
        reviewedAt: new Date().toISOString(),
        investigationStatus: 'resolved',
        ...(notes ? { description: notes } : {}),
      },
    });

    return { data: toFrontendShape(updated) };
  },

  async escalate(ctx) {
    const resolvedId = await resolveDocumentId(strapi, ctx.params.id);
    if (!resolvedId) return ctx.notFound('Anomaly not found');

    const updated = await strapi.documents('api::anomaly.anomaly').update({
      documentId: resolvedId,
      data: {
        severity: 'critical',
        investigationStatus: 'in_progress',
      },
    });

    return { data: toFrontendShape(updated) };
  },
}));