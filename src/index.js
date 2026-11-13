'use strict';

module.exports = {
  register() {},

  async bootstrap({ strapi }) {
    try {
      await require('./v2/seed')();
    } catch (e) {
      strapi.log.error('[v2] seed failed: ' + (e.stack || e.message));
    }
  },
};
