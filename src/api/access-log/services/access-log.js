'use strict';

/**
 * access-log service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::access-log.access-log');
