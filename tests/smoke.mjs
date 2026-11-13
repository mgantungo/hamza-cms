// End-to-end smoke test for the v2 API. Usage: node tools/smoke.mjs [base]
const BASE = process.argv[2] || 'http://127.0.0.1:1337/api/v2';
let jwt = null, term = null, fails = 0;
async function call(method, path, body, extra = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (jwt) h.Authorization = 'Bearer ' + jwt;
  if (term) h['X-Terminal-Token'] = term;
  const res = await fetch(BASE + path, { method, headers: { ...h, ...(extra.headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}
function ok(name, cond, info) { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' → ' + JSON.stringify(info).slice(0, 400))); if (!cond) fails++; }

let r = await call('POST', '/auth/login', { username: 'superadmin', password: 'wrong' });
ok('bad password rejected', r.status === 401, r);
r = await call('POST', '/auth/login', { username: 'superadmin', password: 'ChangeMe!2026' });
ok('super admin login', r.status === 200 && r.data.jwt, r); jwt = r.data.jwt;
const aps = (await call('GET', '/r/access-points')).data.data;
ok('access points seeded', aps.length >= 1, aps);
const roles = (await call('GET', '/r/roles?pageSize=50')).data.data;
ok('11 built-in roles', roles.length === 11, roles.map((x) => x.name));
const role = (n) => roles.find((x) => x.name === n).id;
const depts = (await call('GET', '/r/departments?pageSize=50')).data.data;
const tech = depts.find((d) => d.name === 'Technology').id, eng = depts.find((d) => d.name === 'Engineering').id;
const branch = (await call('GET', '/r/branches')).data.data[0].id;
const cats = (await call('GET', '/r/categories')).data.data;
const it = cats.find((c) => c.name === 'IT equipment').id, furn = cats.find((c) => c.name === 'Furniture').id;

// staff
const mk = async (sid, name, dept, card) => (await call('POST', '/r/staff', { staff_id: sid, staff_name: name, dept, department: '', card_number: card, branch, status: 'active' })).data.data;
const grace = await mk('VGS-01482', 'Grace Nakato', tech, 'CARD-1482');
const daniel = await mk('VGS-00211', 'Daniel Ouma', tech, 'CARD-0211');
const ivan = await mk('VGS-00300', 'Ivan Lubega', eng, 'CARD-0300');
const moses = await mk('VGS-00877', 'Moses Kato', eng, 'CARD-0877');
ok('staff created', grace?.id && moses?.id, grace);

// users
const mkUser = async (u, roleNames, staff, extra = {}) => (await call('POST', '/r/users', { username: u, password: 'Passw0rd!', full_name: u, active: true, roles: roleNames.map(role), branches: [branch], staff, ...extra })).data;
const g = await mkUser('guard1', ['Security'], null, { access_points: [aps[0].id], branches: [] });
ok('guard user', g.data?.id, g);
await mkUser('ivan', ['Manager'], ivan.id);
await mkUser('moses', ['Staff'], moses.id);
await mkUser('store', ['Store Manager'], null);
await mkUser('sup', ['Security Supervisor'], null);
await mkUser('reception', ['Reception'], null);

// enrol terminal
r = await call('POST', '/terminal/enrol', { username: 'guard1', password: 'Passw0rd!', step: 'check' });
ok('guard cannot enrol', r.status === 403, r);
r = await call('POST', '/terminal/enrol', { username: 'superadmin', password: 'ChangeMe!2026', step: 'check' });
ok('admin enrol check lists APs', r.data.accessPoints?.length >= 1, r);
r = await call('POST', '/terminal/enrol', { username: 'superadmin', password: 'ChangeMe!2026', accessPointId: aps[0].id, name: 'Gate PC 1' });
ok('terminal enrolled', r.data.token, r); const token = r.data.token;
term = token;
r = await call('GET', '/terminal');
ok('terminal resolves', r.data.terminal?.accessPoint?.id === aps[0].id, r);

// assets
r = await call('POST', '/assets', { data: { asset_name: 'Dell Latitude 5440', category_ref: it, serial_number: '7HX2Q73', branch, assigned_to: grace.id, make: 'Dell', model: 'Latitude 5440', cost: 4200000 } });
ok('asset created with tag', r.data.tags?.[0]?.startsWith('VG-'), r); const laptop = r.data.data[0];
r = await call('POST', '/assets', { data: { asset_name: 'HP EliteBook 840', category_ref: it, serial_number: '5CG1234', branch, assigned_to: daniel.id } });
const hp = r.data.data[0];
r = await call('POST', '/assets', { data: { asset_name: 'Office desk 1.4 m', category_ref: furn, branch }, quantity: 3 });
ok('bulk furniture tags VG-F-', r.data.tags?.length === 3 && r.data.tags[0].startsWith('VG-F-'), r); const desk = r.data.data[0];
r = await call('POST', '/assets', { data: { asset_name: 'Dell Latitude', category_ref: it, serial_number: '7HX2Q73' } });
ok('duplicate serial refused', r.status === 409, r);

// gate as guard on terminal
jwt = null;
r = await call('POST', '/auth/login', { username: 'guard1', password: 'Passw0rd!' });
ok('guard login at assigned gate', r.status === 200, r); jwt = r.data.jwt;
r = await call('POST', '/gate/identify', { code: 'card-1482' });
ok('identify staff card', r.data.type === 'staff' && r.data.held.length === 1, r);
r = await call('POST', '/gate/scan-item', { code: laptop.tag_number, staffId: grace.id });
ok('own laptop ok', r.data.result === 'ok', r); const dir1 = r.data.direction;
r = await call('POST', '/gate/scan-item', { code: '7HX2Q73', staffId: grace.id });
ok('serial scan flips direction', r.data.direction !== dir1, r);
r = await call('POST', '/gate/scan-item', { code: hp.tag_number, staffId: grace.id });
ok('someone else\'s laptop → exception', r.data.result === 'exception' && r.data.exception.caseNumber, r);
const mvId = r.data.movementId;
r = await call('POST', '/gate/acknowledge', { movementId: mvId });
ok('acknowledge', r.data.ok, r);
r = await call('POST', '/gate/scan-item', { code: desk.tag_number, staffId: grace.id });
ok('fixed desk → exception', r.data.exception?.type === 'fixed_item_at_gate', r);
r = await call('POST', '/gate/scan-item', { code: 'NOPE-1', staffId: grace.id });
ok('unknown item 404', r.status === 404, r);
r = await call('POST', '/gate/identify', { code: 'zzz' });
ok('unknown card 404', r.status === 404, r);
r = await call('GET', '/gate/today');
ok('today counts', r.data.counts.exceptions >= 2, r);
r = await call('GET', '/r/users');
ok('guard cannot list users', r.status === 403, r);

// visitor at gate
r = await call('POST', '/gate/visitor', { name: 'Joan Atim', nin: 'CF92XX41K', phone: '0772', items: [{ type: 'Laptop', make_model: 'Dell XPS 13', serial: 'FJ8K2Q3', sticker: true }, { type: 'Phone', make_model: 'iPhone 14' }] });
ok('visitor registered with items', r.data.visit?.id && r.data.items.length === 2, r);
const visitId = r.data.visit.id; const vsTag = r.data.items[0].tag;

// reception check-in
jwt = (await call('POST', '/auth/login', { username: 'reception', password: 'Passw0rd!' })).data.jwt;
r = await call('GET', '/reception/queue');
ok('reception queue shows waiting', r.data.counts.waiting === 1, r.data.counts);
r = await call('POST', `/reception/visits/${visitId}/check-in`, { hostId: ivan.id, purpose: 'Meeting', badgeNumber: 'B-001' });
ok('check-in with badge', r.data.data?.status === 'in_building', r);
r = await call('POST', '/reception/appointments', { visitor_name: 'Esther Namara', phone: '0701', scheduled_at: new Date(Date.now() + 3600e3).toISOString(), purpose: 'Meeting', host: daniel.id });
ok('appointment booked with invite', r.data.data?.invite_code?.startsWith('INV-'), r); const invite = r.data.data.invite_code;

// visitor exit at gate
jwt = (await call('POST', '/auth/login', { username: 'guard1', password: 'Passw0rd!' })).data.jwt;
r = await call('POST', '/gate/identify', { code: 'B-001' });
ok('badge → visitor exit with items', r.data.type === 'visitor_exit' && r.data.items.length === 2, r);
const phoneId = r.data.items.find((i) => !i.tag).id;
r = await call('POST', '/gate/scan-item', { code: vsTag, visitId });
ok('visitor sticker OUT ok', r.data.result === 'ok' && r.data.direction === 'OUT', r);
r = await call('POST', '/gate/scan-item', { code: laptop.tag_number, visitId });
ok('company item by visitor → exception', r.data.result === 'exception', r);
r = await call('POST', '/gate/visitor-checkout', { visitId, confirmedIds: [phoneId] });
ok('visitor checked out, nothing left', r.data.ok && r.data.leftBehind.length === 0, r);
r = await call('POST', '/gate/identify', { code: invite });
ok('invite identified', r.data.type === 'appointment', r);

// lost item flow
jwt = (await call('POST', '/auth/login', { username: 'superadmin', password: 'ChangeMe!2026' })).data.jwt;
r = await call('POST', '/assets/action', { action: 'lost', ids: [hp.id], reason: 'Left in taxi' });
ok('report lost opens case', r.data.ok, r);
jwt = (await call('POST', '/auth/login', { username: 'guard1', password: 'Passw0rd!' })).data.jwt;
r = await call('POST', '/gate/scan-item', { code: hp.tag_number, staffId: grace.id });
ok('lost item scanned → critical, same case', r.data.exception?.type === 'lost_scanned', r);
jwt = (await call('POST', '/auth/login', { username: 'sup', password: 'Passw0rd!' })).data.jwt;
const caseId = r.data.exception.caseId;
r = await call('GET', `/cases/${caseId}`);
ok('case timeline has gate scan', r.data.timeline?.some((t) => /SCANNED/.test(t.text)), r.data.timeline);
r = await call('POST', `/cases/${caseId}/outcome`, { outcome: 'found', notes: 'Held at gate' });
ok('outcome found restores asset', r.data.data?.status === 'resolved', r);
const a2 = (await call('GET', `/assets/${hp.id}`)).data.data;
ok('asset back to assigned', a2?.asset_status === 'assigned', a2);

// store + requisition
jwt = (await call('POST', '/auth/login', { username: 'superadmin', password: 'ChangeMe!2026' })).data.jwt;
const storeId = (await call('GET', '/r/stores')).data.data[0].id;
const sugar = (await call('POST', '/r/store-items', { code: 'ST-0051', name: 'Sugar 2kg', kind: 'consumable', unit: 'packet', reorder_level: 20, unit_cost: 9000 })).data.data;
const ladder = (await call('POST', '/r/store-items', { code: 'ST-0300', name: 'Ladder 6m', kind: 'returnable', unit: 'pcs', unit_cost: 450000 })).data.data;
r = await call('POST', '/store/tx', { type: 'receive', storeId, lines: [{ itemId: sugar.id, qty: 30 }, { itemId: ladder.id, qty: 2 }], supplier: 'Shoprite' });
ok('receive stock', r.data.ok, r);
r = await call('POST', '/store/tx', { type: 'issue', storeId, takerCode: 'CARD-0877', lines: [{ itemId: sugar.id, qty: 100 }] });
ok('over-issue refused', r.status === 409, r);
r = await call('POST', '/store/tx', { type: 'lend', storeId, takerCode: 'CARD-0877', due_date: '2026-11-20', lines: [{ itemId: ladder.id, qty: 1 }] });
ok('lend ladder', r.data.ok, r);
const loans = (await call('GET', '/store/loans')).data.data;
r = await call('POST', '/store/return', { loanId: loans[0].id, condition_in: 'good' });
ok('return ladder', r.data.done, r);

r = await call('POST', '/auth/login', { username: 'moses', password: 'Passw0rd!' });
ok('staff refused on gate terminal', r.status === 403, r);
term = null;
jwt = (await call('POST', '/auth/login', { username: 'moses', password: 'Passw0rd!' })).data.jwt;
r = await call('POST', '/requisitions', { type: 'consumable', storeId, purpose: 'Kitchen', lines: [{ itemId: sugar.id, qty: 10 }], submit: true });
ok('staff submits requisition', r.data.data?.status === 'submitted', r); const reqId = r.data.data.id;
r = await call('POST', `/requisitions/${reqId}/decide`, { decision: 'approve' });
ok('requester cannot approve', r.status === 403, r);
jwt = (await call('POST', '/auth/login', { username: 'ivan', password: 'Passw0rd!' })).data.jwt;
r = await call('GET', '/requisitions/inbox');
ok('manager inbox has it', r.data.data?.some((x) => x.id === reqId), r);
r = await call('POST', `/requisitions/${reqId}/decide`, { decision: 'approve', approvedQty: { 0: 6 }, comment: 'Stock low' });
ok('manager approves and reduces', r.data.data?.lines?.[0]?.qty_approved === 6, r);
jwt = (await call('POST', '/auth/login', { username: 'store', password: 'Passw0rd!' })).data.jwt;
r = await call('POST', `/requisitions/${reqId}/decide`, { decision: 'approve' });
ok('store manager final approval', r.data.data?.status === 'approved', r);
r = await call('POST', `/requisitions/${reqId}/issue`, { lines: [{ idx: 0, qty: 6 }] });
ok('issued', r.data.data?.status === 'issued', r);
jwt = (await call('POST', '/auth/login', { username: 'moses', password: 'Passw0rd!' })).data.jwt;
r = await call('POST', `/requisitions/${reqId}/confirm`);
ok('requester confirms receipt', r.data.data?.status === 'received', r);

// reports & export
jwt = (await call('POST', '/auth/login', { username: 'superadmin', password: 'ChangeMe!2026' })).data.jwt;
r = await call('GET', '/dashboard');
ok('dashboard', r.data.kpis?.total >= 5, r);
r = await call('GET', '/reports/movements');
ok('movements report', r.data.rows?.length >= 5, r);
for (const f of ['csv', 'sql']) { r = await call('GET', `/reports/movements?format=${f}`); ok(`export ${f}`, r.status === 200 && typeof r.data === 'string' && r.data.length > 50, r.status); }
const x = await fetch(BASE + '/reports/register?format=xlsx', { headers: { Authorization: 'Bearer ' + jwt } });
ok('export xlsx', x.status === 200 && (await x.arrayBuffer()).byteLength > 2000, x.status);
const t = await fetch(BASE + '/import/assets/template', { headers: { Authorization: 'Bearer ' + jwt } });
ok('import template', t.status === 200, t.status);
r = await call('GET', '/reports/audit');
ok('audit trail has entries', r.data.rows?.length > 10, r.data.total);
// vehicle gate
term = null;
jwt = (await call('POST', '/auth/login', { username: 'superadmin', password: 'ChangeMe!2026' })).data.jwt;
const vcat = cats.find((c) => c.name === 'Vehicles').id;
r = await call('POST', '/assets', { data: { asset_name: 'Toyota Hiace', category_ref: vcat, serial_number: 'uax 551k', branch, assigned_to: ivan.id } });
ok('vehicle created, plate normalised', r.data.data?.[0]?.serial_number === 'UAX551K', r);
const van = r.data.data[0];
r = await call('POST', '/assets', { data: { asset_name: 'No plate', category_ref: vcat } });
ok('vehicle needs a plate', r.status === 400, r);
r = await call('GET', '/r/passcards');
ok('passcards seeded', r.data.data?.length >= 1, r);
const pass = r.data.data.find((p) => p.passcard_status === 'available').passcard_number;
term = token;
jwt = (await call('POST', '/auth/login', { username: 'guard1', password: 'Passw0rd!' })).data.jwt;
r = await call('POST', '/vehicle-gate/identify', { code: JSON.stringify({ assetId: 'UAX 551K', assetType: 'vehicle', recordId: van.id }) });
ok('vehicle QR (JSON) identified', r.data.type === 'vehicle' && r.data.vehicle.next === 'IN' && r.data.method === 'QR scan', r);
r = await call('POST', '/vehicle-gate/identify', { code: 'VEHICLE|UAX551K' });
ok('vehicle QR (pipe) identified', r.data.type === 'vehicle', r);
r = await call('POST', '/gate/identify', { code: 'VEHICLE|UAX551K' });
ok('pedestrian gate routes vehicle QR', r.data.type === 'vehicle', r);
r = await call('POST', '/vehicle-gate/identify', { code: 'CARD-0300' });
ok('driver card identified with their vehicle', r.data.type === 'staff' && r.data.vehicles.length === 1, r);
r = await call('POST', '/vehicle-gate/record', { vehicleId: van.id, staffId: ivan.id, method: 'QR scan' });
ok('assigned driver IN ok', r.data.result === 'ok' && r.data.direction === 'IN', r);
r = await call('POST', '/vehicle-gate/record', { vehicleId: van.id, staffId: grace.id });
ok('wrong driver → exception OUT', r.data.result === 'exception' && r.data.direction === 'OUT' && r.data.exception.type === 'vehicle_driver_mismatch', r);
r = await call('POST', '/vehicle-gate/identify', { code: 'UBJ 204Q' });
ok('unknown plate 404', r.status === 404, r);
r = await call('POST', '/vehicle-gate/guest-in', { plate: 'UBJ 204Q', visitor_name: 'Esther Namara', purpose: 'Delivery', passcard: pass });
ok('guest vehicle in', r.data.passcard === pass, r);
r = await call('POST', '/vehicle-gate/guest-in', { plate: 'UBK 1', visitor_name: 'X', passcard: pass });
ok('issued passcard refused', r.status === 409, r);
r = await call('POST', '/vehicle-gate/identify', { code: pass });
ok('passcard scan finds the session', r.data.type === 'passcard' && r.data.session?.plate_number === 'UBJ204Q' && r.data.session?.passcard?.passcard_number === pass, r);
r = await call('POST', '/vehicle-gate/guest-out', { passcard: pass });
ok('guest vehicle out', r.data.ok, r);
r = await call('GET', '/vehicle-gate/today');
ok('vehicle today log', r.data.rows.length >= 4 && r.data.counts.exceptions >= 1, r.data.counts);
jwt = (await call('POST', '/auth/login', { username: 'superadmin', password: 'ChangeMe!2026' })).data.jwt;
r = await call('GET', '/vehicles');
ok('fleet list', r.data.data.length === 1 && r.data.counts.total === 1, r.data.counts);
r = await call('GET', '/reports/guest_vehicles');
ok('guest vehicles report', r.data.rows?.length >= 1, r);
r = await fetch('http://127.0.0.1:1337/api/company-assets');
ok('v1 public REST is closed', r.status === 404 || r.status === 403, r.status);

r = await call('GET', `/r/assets?filters[id][$in][0]=${laptop.id}&filters[id][$in][1]=${hp.id}`);
ok('id filter on generic lists', r.data.data?.length === 2, r.data.meta);
// the remaining routes
r = await call('GET', '/auth/me');
ok('auth/me returns user', r.data.user?.username === 'superadmin', r);
const store2 = (await call('POST', '/r/stores', { name: 'Jinja Store', branch, active: true })).data.data;
r = await call('POST', '/store/tx', { type: 'transfer', storeId, toStoreId: store2.id, lines: [{ itemId: sugar.id, qty: 4 }] });
ok('transfer between stores', r.data.ok, r);
r = await call('GET', `/store/stock?storeId=${store2.id}`);
ok('stock arrived in second store', r.data.data.find((i) => i.id === sugar.id)?.qty === 4, r.data.data);
r = await call('POST', '/store/tx', { type: 'receive', storeId, lines: [{ itemId: sugar.id, qty: 5, expiry_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) }] });
r = await call('GET', '/store/alerts');
ok('expiry alerts', r.data.expiring.length >= 1, r);
r = await call('POST', '/reception/close-day');
ok('close the day', typeof r.data.casesOpened === 'number', r);
r = await call('PUT', `/r/staff/${grace.id}`, { data: { status: 'left' } });
ok('exit clearance blocks Left while items held', r.status === 409, r);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
