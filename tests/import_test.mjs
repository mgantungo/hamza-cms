// Builds a small asset sheet (with deliberate errors) and runs preview → commit.
import ExcelJS from 'exceljs'
const BASE = 'http://127.0.0.1:1337/api/v2'
const login = await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'superadmin', password: 'ChangeMe!2026' }) })).json()
const H = { Authorization: 'Bearer ' + login.jwt }
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Assets')
ws.addRow(['Name*', 'Category*', 'Serial', 'Purchase date', 'Branch*', 'Custodian staff ID', 'Cost'])
ws.addRow(['Lenovo ThinkPad E14', 'IT equipment', 'PF3K91XQ', '12/03/2025', 'Head Office', 'VGS-01482', '3,500,000'])
ws.addRow(['Office chair', 'Furniture', '', '04/08/2024', 'Head Office', '', ''])
ws.addRow(['Dell Latitude', 'IT equipment', '7HX2Q73', '01/02/2026', 'Head Office', '', ''])   // duplicate serial
ws.addRow(['Printer', 'Printers', 'PHBQ4321', '31/02/2025', 'Head Office', 'NOPE', ''])   // bad category, bad date, bad staff
await wb.xlsx.writeFile('/tmp/assets_import.xlsx')
const fd = new FormData(); fd.append('file', new Blob([await (await import('fs')).promises.readFile('/tmp/assets_import.xlsx')]), 'assets_import.xlsx')
const pv = await (await fetch(BASE + '/import/assets/preview', { method: 'POST', headers: H, body: fd })).json()
console.log('preview counts', pv.counts, 'mapped', pv.mapped)
pv.rows.forEach((r) => Object.keys(r.errors).length && console.log('  row', r.row, r.errors))
const cm = await (await fetch(BASE + '/import/assets/commit', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: pv.rows }) })).json()
console.log('commit', cm)
const ok = pv.counts.valid === 2 && pv.counts.errors === 2 && cm.created === 2 && cm.rejected === 2
console.log(ok ? 'IMPORT PASSED' : 'IMPORT FAILED'); process.exit(ok ? 0 : 1)
