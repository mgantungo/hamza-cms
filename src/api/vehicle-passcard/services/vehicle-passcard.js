'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService(
  'api::vehicle-passcard.vehicle-passcard',
  ({ strapi }) => ({
    async findByCardNumber(card) {
      const [entry] = await strapi.db.query('api::vehicle-passcard.vehicle-passcard').findMany({
        where: { passcard_number: { $eqi: card.trim() } },
        limit: 1,
      });
      return entry || null;
    },
  }),
);