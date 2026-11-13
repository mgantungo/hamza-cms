'use strict';

const { factories } = require('@strapi/strapi');

function startOfDayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

module.exports = factories.createCoreController('api::guest-access-log.guest-access-log', ({ strapi }) => ({
  async createCustom(ctx) {
    const body = ctx.request.body.data || ctx.request.body || {};

    if (body.guest !== undefined && typeof body.guest === 'string') {
      const matches = await strapi.documents('api::guest.guest').findMany({
        filters: { nin: body.guest },
      });
      if (matches.length) body.guest = matches[0].documentId;
    }

    const created = await strapi.documents('api::guest-access-log.guest-access-log').create({
      data: body,
      populate: { guest: true },
    });
    return { data: created };
  },

  async today(ctx) {
    const { location } = ctx.params;
    const entries = await strapi.documents('api::guest-access-log.guest-access-log').findMany({
      filters: {
        location,
        createdAt: { $gte: startOfDayISO() },
      },
      populate: { guest: true },
    });
    return { data: entries };
  },
}));