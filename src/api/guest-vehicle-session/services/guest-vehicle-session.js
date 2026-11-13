'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService(
  'api::guest-vehicle-session.guest-vehicle-session',
  ({ strapi }) => ({
    async findActiveByPlate(plate) {
    const [entry] = await strapi.db.query('api::guest-vehicle-session.guest-vehicle-session').findMany({
        where: { plate_number: { $eqi: plate.trim() }, session_status: 'checked_in' },  // fixed: session_status
        populate: { passcard: true },
        orderBy: { createdAt: 'desc' },
        limit: 1,
    });
    return entry || null;
    },

    async findActiveByPasscard(card) {
    const [entry] = await strapi.db.query('api::guest-vehicle-session.guest-vehicle-session').findMany({
        where: {
        passcard: { passcard_number: { $eqi: card.trim() } },
        session_status: 'checked_in',
        },
        populate: { passcard: true },
        orderBy: { createdAt: 'desc' },
        limit: 1,
    });
    return entry || null;
    },

    async findToday(location) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      return strapi.db.query('api::guest-vehicle-session.guest-vehicle-session').findMany({
        where: { location, createdAt: { $gte: startOfDay.toISOString() } },
        orderBy: { createdAt: 'desc' },
        limit: 200,
      });
    },
  }),
);