// Checks that every API call in the web app has a matching CMS route / resource,
// and every Nuxt server call has a server route. Usage: node tests/route_audit.js ../app
const fs = require('fs');
const path = require('path');
const appDir = path.resolve(process.argv[2] || '../app');
const routes = require('../src/api/v2/routes/v2.js').routes.map((r) => ({ method: r.method, path: r.path.replace(/^\/v2/, ''), handler: r.handler }));
const { R } = require('../src/v2/handlers/resources.js');
const controller = Object.keys(require('../src/api/v2/controllers/v2.js'));

function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (['node_modules', '.output', '.nuxt'].includes(d.name) ? [] : files(path.join(dir, d.name))) : /\.(vue|ts)$/.test(d.name) ? [path.join(dir, d.name)] : [])); }
const src = files(path.join(appDir, 'app'));
const problems = []; const calls = []; const resources = new Set();

for (const f of src) {
  const s = fs.readFileSync(f, 'utf8');
  const rel = path.relative(appDir, f);
  const re = /api\.(get|post|put|del|download|request)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  let m;
  while ((m = re.exec(s))) {
    let p = m[2].slice(1, -1).replace(/\$\{[^}]+\}/g, ':x').split('?')[0];
    let method = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE', download: 'GET' }[m[1]];
    if (m[1] === 'request') { const tail = s.slice(m.index, m.index + 200); method = (tail.match(/method:\s*'(\w+)'/) || [, 'GET'])[1]; }
    calls.push({ file: rel, method, path: p });
  }
  for (const r of s.matchAll(/api\.(list|save)\(\s*'([^']+)'/g)) resources.add(`${r[2]}|${rel}`);
  for (const r of s.matchAll(/\bresource(?:s)?="([a-z-]+)"/g)) resources.add(`${r[1]}|${rel}`);
  for (const r of s.matchAll(/resource:\s*'([a-z-]+)'/g)) resources.add(`${r[1]}|${rel}`);
  for (const r of s.matchAll(/\/r\/\$\{props\.resource\}|\/r\/([a-z-]+)\//g)) if (r[1]) resources.add(`${r[1]}|${rel}`);
  for (const r of s.matchAll(/\$fetch\(\s*'([^']+)'/g)) {
    const p = r[1];
    const server = path.join(appDir, 'server');
    const candidates = [path.join(server, p + '.ts'), path.join(server, p, 'index.get.ts'), path.join(server, p + '.post.ts'), path.join(server, p + '.get.ts')];
    const v2 = p.startsWith('/api/v2/');
    if (v2) calls.push({ file: rel, method: 'POST', path: p.replace('/api/v2', '') });
    else if (!candidates.some((c) => fs.existsSync(c))) problems.push(`Nuxt server route missing for $fetch('${p}') in ${rel}`);
  }
}
const match = (call) => routes.some((r) => r.method === call.method && r.path.split('/').length === call.path.split('/').length && r.path.split('/').every((seg, i) => seg.startsWith(':') || seg === call.path.split('/')[i] || call.path.split('/')[i] === ':x'));
for (const c of calls) {
  if (c.path.startsWith('/r/')) { const res = c.path.split('/')[2]; if (res !== ':x' && !R[res]) problems.push(`Unknown resource ${res} (${c.file})`); continue; }
  if (!match(c)) problems.push(`No CMS route for ${c.method} ${c.path} (${c.file})`);
}
for (const r of resources) { const [res, file] = r.split('|'); if (!R[res]) problems.push(`Unknown resource "${res}" (${file})`); }
for (const r of routes) if (!controller.includes(r.handler.replace(/^v2\./, ''))) problems.push(`Route ${r.method} ${r.path} → handler ${r.handler} missing`);
// every page link in the nav exists
const nav = fs.readFileSync(path.join(appDir, 'app/composables/useNav.ts'), 'utf8');
for (const m of nav.matchAll(/to: '([^'?]+)/g)) {
  const p = m[1];
  const base = path.join(appDir, 'app/pages', p);
  if (![base + '.vue', path.join(base, 'index.vue')].some((x) => fs.existsSync(x))) problems.push(`Nav link ${p} has no page`);
}
// NuxtLink / navigateTo targets
for (const f of src) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/(?:to="|navigateTo\(\s*[`'])(\/[a-z][^"`'?{$]*)/g)) {
    const p = m[1].replace(/\/$/, '');
    const parts = p.split('/').filter(Boolean);
    let dir = path.join(appDir, 'app/pages'); let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const name = parts[i];
      if (last && (fs.existsSync(path.join(dir, name + '.vue')) || fs.existsSync(path.join(dir, name, 'index.vue')))) break;
      if (fs.existsSync(path.join(dir, name))) { dir = path.join(dir, name); continue; }
      const dyn = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.startsWith('['));
      if (dyn) { if (last && dyn.endsWith('.vue')) break; dir = path.join(dir, dyn); continue; }
      ok = false; break;
    }
    if (!ok) problems.push(`Link to ${p} has no page (${path.relative(appDir, f)})`);
  }
}
console.log(`${calls.length} API calls, ${resources.size} resource uses, ${routes.length} CMS routes checked.`);
if (problems.length) { console.log([...new Set(problems)].join('\n')); process.exit(1); }
console.log('ROUTE AUDIT PASSED');
