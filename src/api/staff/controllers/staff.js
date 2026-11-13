'use strict';

const { factories } = require('@strapi/strapi');

module.exports = factories.createCoreController('api::staff.staff', ({ strapi }) => ({
  async all(ctx) {
    const entries = await strapi.documents('api::staff.staff').findMany({
      populate: '*',
    });
    return { data: entries };
  },

  async byId(ctx) {
    const { id } = ctx.params;
    const entries = await strapi.documents('api::staff.staff').findMany({
      filters: { staff_id: id },
      populate: '*',
    });
    if (!entries.length) return ctx.notFound('Staff not found');
    return entries[0];
  },

  async byNin(ctx) {
    // staff has no nin field in your schema — this route exists only
    // for parity with the frontend's fallback call, it should never
    // actually match a record.
    return ctx.notFound('Staff lookup by NIN is not supported');
  },
}));