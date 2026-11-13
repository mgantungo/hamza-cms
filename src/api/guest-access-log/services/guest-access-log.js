'use strict';

/**
 * guest-access-log service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::guest-access-log.guest-access-log');
