'use strict';
/**
 * v2 RBAC policy. Route config: { name: 'global::authorize', config: { module, action } }.
 * Without module/action it only requires a valid login.
 */
const { errors } = require('@strapi/utils');
const L = require('../v2/lib');

module.exports = async (policyContext, config = {}) => {
  const ctx = policyContext;
  const user = await L.userFromCtx(ctx);
  if (!user) throw new errors.UnauthorizedError('Please sign in again');
  ctx.state.appUser = user;
  if (config.module) {
    const anyOf = Array.isArray(config.module) ? config.module : [config.module];
    const ok = anyOf.some((m) => L.can(user, m, config.action || 'view'));
    if (!ok) throw new errors.ForbiddenError('Your role does not allow this');
  }
  return true;
};
