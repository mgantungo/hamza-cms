'use strict';

const { factories } = require('@strapi/strapi');

module.exports = factories.createCoreController('api::guest.guest', ({ strapi }) => ({
  async create(ctx) {
    const body = ctx.request.body.data || ctx.request.body || {};

    if (body.nin) {
      const existing = await strapi.documents('api::guest.guest').findMany({
        filters: { nin: body.nin },
      });
      if (existing.length) {
        // Reuse existing guest instead of erroring on duplicate NIN
        return { data: existing[0] };
      }
    }

    ctx.request.body.data = body;
    return super.create(ctx);
  },

  async byNin(ctx) {
    const { nin } = ctx.params;
    const entries = await strapi.documents('api::guest.guest').findMany({
      filters: { nin },
    });
    if (!entries.length) return ctx.notFound('Guest not found');
    return entries[0];
  },
}));