'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController(
  'api::vehicle-passcard.vehicle-passcard',
  ({ strapi }) => ({
    async lookup(ctx) {
      const { card } = ctx.params;
      const entry = await strapi
        .service('api::vehicle-passcard.vehicle-passcard')
        .findByCardNumber(card);
      if (!entry) return ctx.notFound();
      ctx.body = { data: entry };
    },
  }),
);