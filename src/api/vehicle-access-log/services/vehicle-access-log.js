'use strict';

/**
 * vehicle-access-log service.
 * findToday / findLastByPlate back the two custom controller actions.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService(
  'api::vehicle-access-log.vehicle-access-log',
  ({ strapi }) => ({
    async findToday(location) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      return strapi.db.query('api::vehicle-access-log.vehicle-access-log').findMany({
        where: {
          location,
          createdAt: { $gte: startOfDay.toISOString() },
        },
        orderBy: { createdAt: 'desc' },
        populate: { vehicle: true, driver: true },
        limit: 200,
      });
    },

    async findLastByPlate(plate) {
      const normalized = plate.trim();
      const [entry] = await strapi.db.query('api::vehicle-access-log.vehicle-access-log').findMany({
        where: {
          vehicle: { tag_number: { $eqi: normalized } }, 
        },
        orderBy: { createdAt: 'desc' },
        populate: { vehicle: true, driver: true },
        limit: 1,
      });
      return entry || null;
    },
  }),
);