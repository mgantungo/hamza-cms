'use strict';
/**
 * Single controller for /api/v2: handler names are "<area>.<fn>".
 * Strapi resolves "v2.auth.login" → this object's key "auth.login".
 */
const areas = {
  auth: require('../../../v2/handlers/auth'),
  resources: require('../../../v2/handlers/resources'),
  gate: require('../../../v2/handlers/gate'),
  reception: require('../../../v2/handlers/reception'),
  assets: require('../../../v2/handlers/assets'),
  cases: require('../../../v2/handlers/cases'),
  store: require('../../../v2/handlers/store'),
  requisitions: require('../../../v2/handlers/requisitions'),
  reports: require('../../../v2/handlers/reports'),
  imports: require('../../../v2/handlers/imports'),
  vehicles: require('../../../v2/handlers/vehicles'),
};

const controller = {};
for (const [area, mod] of Object.entries(areas)) {
  for (const [fn, impl] of Object.entries(mod)) {
    if (typeof impl !== 'function' || /^[A-Z]/.test(fn)) continue;
    controller[`${area}_${fn}`] = async (ctx) => {
      try {
        const out = await impl(ctx);
        if (out !== undefined && ctx.body === undefined) ctx.body = out;
        else if (out !== undefined && ctx.status < 400) ctx.body = out;
      } catch (e) {
        strapi.log.error(`[v2] ${area}.${fn}: ${e.stack || e.message}`);
        ctx.status = e.status || 500;
        ctx.body = { error: { status: ctx.status, message: e.status ? e.message : 'Something went wrong. Try again or tell ICT.' } };
      }
    };
  }
}
module.exports = controller;
