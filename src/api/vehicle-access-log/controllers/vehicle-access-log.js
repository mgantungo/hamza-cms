'use strict';

/**
 * vehicle-access-log controller.
 * `create`, `find`, `findOne`, `update`, `delete` come free from
 * createCoreController. `today` and `last` back the two custom routes.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController(
  'api::vehicle-access-log.vehicle-access-log',
  ({ strapi }) => ({
    // GET /vehicle-access-logs/today/:location
    async today(ctx) {
      const { location } = ctx.params;
      if (!location) {
        return ctx.badRequest('location is required');
      }

      const entries = await strapi
        .service('api::vehicle-access-log.vehicle-access-log')
        .findToday(location);

      ctx.body = { data: entries };
    },

    // GET /vehicle-access-logs/last/:tag
    async last(ctx) {
      const { tag } = ctx.params;
      if (!tag) {
        return ctx.badRequest('tag is required');
      }

      const entry = await strapi
        .service('api::vehicle-access-log.vehicle-access-log')
        .findLastByPlate(tag);

      if (!entry) {
        return ctx.notFound();
      }

      ctx.body = { data: entry };
    },
  }),
);