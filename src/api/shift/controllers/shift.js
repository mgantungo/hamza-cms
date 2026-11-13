'use strict';
const { factories } = require('@strapi/strapi');
module.exports = factories.createCoreController('api::shift.shift', ({ strapi }) => ({
  async active(ctx) {
    const { entrance } = ctx.params;
    const entries = await strapi.documents('api::shift.shift').findMany({
      filters: { entrance, active: true }, sort: { start_time: 'desc' },
    });
    if (!entries.length) return ctx.notFound('No active shift');
    return { data: entries[0] };
  },
  async create(ctx) {
    const body = ctx.request.body.data || ctx.request.body || {};
    ctx.request.body.data = body;
    return super.create(ctx);
  },
}));