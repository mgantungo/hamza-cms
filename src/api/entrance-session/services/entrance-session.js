'use strict';

/**
 * entrance-session service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::entrance-session.entrance-session');
