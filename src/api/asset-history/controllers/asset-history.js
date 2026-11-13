'use strict';

const { factories } = require('@strapi/strapi');

module.exports = factories.createCoreController('api::asset-history.asset-history', ({ strapi }) => ({
  async byAsset(ctx) {
    const { tag } = ctx.params;
    const entries = await strapi.documents('api::asset-history.asset-history').findMany({
      filters: { company_asset: { tag_number: tag } },
      populate: { company_asset: true },
      sort: { event_date: 'desc' },
    });
    return { data: entries };
  },
}));