'use strict';

/**
 * anomaly service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::anomaly.anomaly');
