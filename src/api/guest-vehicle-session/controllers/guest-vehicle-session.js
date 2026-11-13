'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController(
  'api::guest-vehicle-session.guest-vehicle-session',
  ({ strapi }) => ({
    async activeByPlate(ctx) {
      const { plate } = ctx.params;

      const entry = await strapi
        .service('api::guest-vehicle-session.guest-vehicle-session')
        .findActiveByPlate(plate);

      if (!entry) return ctx.notFound();

      ctx.body = { data: entry };
    },

    async passcardStatus(ctx) {
      const { card } = ctx.params;

      const entry = await strapi
        .service('api::guest-vehicle-session.guest-vehicle-session')
        .findActiveByPasscard(card);

      ctx.body = { data: entry };
    },

    async today(ctx) {
      const { location } = ctx.params;

      const entries = await strapi
        .service('api::guest-vehicle-session.guest-vehicle-session')
        .findToday(location);

      ctx.body = { data: entries };
    },
  })
);