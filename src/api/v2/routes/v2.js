'use strict';
/** All v2 endpoints. Strapi's own auth is off (auth:false); the authorize policy does JWT + RBAC. */
const P = (module, action) => ({ auth: false, policies: [{ name: 'global::authorize', config: module ? { module, action } : {} }] });
const PUBLIC = { auth: false, policies: [] };

const r = (method, path, handler, config) => ({ method, path: `/v2${path}`, handler: `v2.${handler.replace('.', '_')}`, config });

module.exports = {
  routes: [
    // auth & terminals
    r('POST', '/auth/login', 'auth.login', PUBLIC),
    r('GET', '/auth/me', 'auth.me', P()),
    r('POST', '/auth/logout', 'auth.logout', P()),
    r('POST', '/auth/password', 'auth.changePassword', P()),
    r('GET', '/terminal', 'auth.resolveTerminal', PUBLIC),
    r('POST', '/terminal/enrol', 'auth.enrol', PUBLIC),
    r('GET', '/notifications', 'auth.myNotifications', P()),
    r('POST', '/notifications/read', 'auth.readNotifications', P()),

    // generic resources (permission checked per resource inside)
    r('GET', '/r/:resource', 'resources.list', P()),
    r('GET', '/r/:resource/:id', 'resources.one', P()),
    r('POST', '/r/:resource', 'resources.create', P()),
    r('PUT', '/r/:resource/:id', 'resources.update', P()),
    r('DELETE', '/r/:resource/:id', 'resources.remove', P()),

    // gate
    r('POST', '/gate/identify', 'gate.identify', P('gate', 'create')),
    r('POST', '/gate/scan-item', 'gate.scanItem', P('gate', 'create')),
    r('POST', '/gate/acknowledge', 'gate.acknowledge', P('gate', 'create')),
    r('GET', '/gate/today', 'gate.today', P('gate', 'view')),
    r('GET', '/gate/find', 'gate.find', P('gate', 'view')),
    r('POST', '/gate/visitor', 'gate.registerVisitor', P('gate', 'create')),
    r('POST', '/gate/visitor-checkout', 'gate.visitCheckout', P('gate', 'create')),

    // vehicle gate & fleet
    r('POST', '/vehicle-gate/identify', 'vehicles.identify', P('gate', 'create')),
    r('POST', '/vehicle-gate/record', 'vehicles.record', P('gate', 'create')),
    r('GET', '/vehicle-gate/today', 'vehicles.today', P('gate', 'view')),
    r('POST', '/vehicle-gate/guest-in', 'vehicles.guestIn', P('gate', 'create')),
    r('POST', '/vehicle-gate/guest-out', 'vehicles.guestOut', P('gate', 'create')),
    r('GET', '/vehicles', 'vehicles.fleet', P(['assets', 'gate'], 'view')),

    // reception
    r('GET', '/reception/queue', 'reception.queue', P('reception', 'view')),
    r('POST', '/reception/walk-in', 'reception.walkIn', P('reception', 'create')),
    r('POST', '/reception/visits/:id/check-in', 'reception.checkIn', P('reception', 'edit')),
    r('POST', '/reception/visits/:id/decline', 'reception.decline', P('reception', 'edit')),
    r('POST', '/reception/appointments', 'reception.book', P('reception', 'create')),
    r('POST', '/reception/appointments/:id/cancel', 'reception.cancel', P('reception', 'create')),
    r('GET', '/reception/mine', 'reception.mine', P()),
    r('POST', '/reception/close-day', 'reception.closeDay', P('reception', 'edit')),

    // assets & non-company items
    r('POST', '/assets', 'assets.create', P()),
    r('GET', '/assets/mine', 'assets.mine', P()),
    r('GET', '/assets/lookup/:code', 'assets.lookup', P()),
    r('GET', '/assets/:id', 'assets.get', P()),
    r('POST', '/assets/action', 'assets.action', P()),
    r('POST', '/assets/:id/approve-personal', 'assets.approvePersonal', P('noncompany', 'approve')),

    // investigations
    r('POST', '/cases', 'cases.create', P('investigations', 'create')),
    r('GET', '/cases/:id', 'cases.get', P('investigations', 'view')),
    r('PUT', '/cases/:id', 'cases.update', P('investigations', 'edit')),
    r('POST', '/cases/:id/note', 'cases.note', P('investigations', 'edit')),
    r('POST', '/cases/:id/evidence', 'cases.evidence', P('investigations', 'edit')),
    r('POST', '/cases/:id/outcome', 'cases.outcome', P('investigations', 'edit')),
    r('POST', '/cases/:id/write-off', 'cases.decideWriteOff', P('investigations', 'approve')),

    // store
    r('GET', '/store/stock', 'store.stock', P(['store', 'requisitions'], 'view')),
    r('POST', '/store/tx', 'store.tx', P('store', 'create')),
    r('GET', '/store/loans', 'store.loans', P('store', 'view')),
    r('POST', '/store/return', 'store.returnLoan', P('store', 'create')),
    r('GET', '/store/alerts', 'store.alerts', P('store', 'view')),

    // requisitions
    r('GET', '/requisitions', 'requisitions.list', P('requisitions', 'view')),
    r('GET', '/requisitions/inbox', 'requisitions.inbox', P('requisitions', 'view')),
    r('POST', '/requisitions/route', 'requisitions.route', P('requisitions', 'create')),
    r('POST', '/requisitions', 'requisitions.save', P('requisitions', 'create')),
    r('GET', '/requisitions/:id', 'requisitions.get', P('requisitions', 'view')),
    r('PUT', '/requisitions/:id', 'requisitions.save', P('requisitions', 'create')),
    r('POST', '/requisitions/:id/decide', 'requisitions.decide', P('requisitions', 'approve')),
    r('POST', '/requisitions/:id/issue', 'requisitions.issue', P(['store', 'assets'], 'create')),
    r('POST', '/requisitions/:id/confirm', 'requisitions.confirm', P('requisitions', 'view')),
    r('POST', '/requisitions/:id/cancel', 'requisitions.cancel', P('requisitions', 'create')),

    // reports, dashboard, imports
    r('GET', '/dashboard', 'reports.dashboard', P()),
    r('GET', '/reports', 'reports.catalogue', P()),
    r('GET', '/reports/:key', 'reports.run', P()),
    r('GET', '/import/:entity/template', 'imports.template', P('imports', 'view')),
    r('POST', '/import/:entity/preview', 'imports.preview', P('imports', 'create')),
    r('POST', '/import/:entity/commit', 'imports.commit', P('imports', 'create')),
  ],
};
