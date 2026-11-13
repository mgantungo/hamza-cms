'use strict';
// v1 REST routes are closed; everything goes through /api/v2 with sign-in and role checks.
const { factories } = require('@strapi/strapi');
module.exports = factories.createCoreRouter('api::guest-vehicle-session.guest-vehicle-session', { only: [] });
