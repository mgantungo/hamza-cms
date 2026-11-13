'use strict';
const { factories } = require('@strapi/strapi');
module.exports = factories.createCoreRouter('api::audit-log.audit-log', { only: [] });
