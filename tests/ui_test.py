"""Drives the real UI in headless Chrome: enrol a terminal, guard scans, admin pages. Screenshots in tools/shots."""
import sys, time
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:3000'
OUT = '/home/claude/v2/tools/shots/'
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errors.append(f'console: {m.text}'))
    page.on('response', lambda r: r.status >= 400 and errors.append(f'{r.status} {r.url}'))
    def shot(n): page.screenshot(path=OUT + n + '.png', full_page=False)

    # 1. enrol terminal
    page.goto(BASE + '/enrol'); page.wait_for_timeout(800)
    page.fill('input[autocomplete=username]', 'superadmin'); page.fill('input[type=password]', 'ChangeMe!2026')
    page.click('button:has-text("Continue")'); page.wait_for_timeout(800)
    page.select_option('select', index=1); page.wait_for_timeout(300)
    page.locator("label:has-text(\"Staff Entrance\")").first.click()
    shot('01-enrol')
    page.click('button:has-text("Enrol this terminal")'); page.wait_for_timeout(1500)
    shot('02-login-terminal')
    # 2. guard login
    page.fill('#u', 'guard1'); page.fill('#p', 'Passw0rd!'); page.click('button:has-text("Sign in")'); page.wait_for_timeout(1500)
    print('after guard login:', page.url)
    shot('03-gate-card')
    # scan card via keyboard only (focus guard should have the field)
    page.keyboard.type('CARD-1482'); page.keyboard.press('Enter'); page.wait_for_timeout(1000)
    shot('04-gate-item-step')
    tag = page.locator('aside li .mono').first.inner_text()
    page.keyboard.type(tag); page.keyboard.press('Enter'); page.wait_for_timeout(1000)
    shot('05-gate-item-ok')
    # someone else's laptop -> exception
    page.keyboard.type('5CG1234'); page.keyboard.press('Enter'); page.wait_for_timeout(1200)
    shot('06-gate-exception')
    page.keyboard.press('Enter'); page.wait_for_timeout(300)
    still = page.locator('.alert-full').count()
    print('exception still showing after Enter:', still)
    page.keyboard.press('F2'); page.wait_for_timeout(800)
    print('exception after F2:', page.locator('.alert-full').count())
    page.keyboard.press('Escape'); page.wait_for_timeout(600)
    # unknown card
    page.keyboard.type('ZZZ999'); page.keyboard.press('Enter'); page.wait_for_timeout(800)
    shot('07-gate-fail')
    page.keyboard.press('F4'); page.wait_for_timeout(500); shot('08-gate-f4')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    page.click('button:has-text("Sign out")'); page.wait_for_timeout(1000)

    # vehicle gate on the same terminal (super admin may use any gate)
    page.fill('#u', 'superadmin'); page.fill('#p', 'ChangeMe!2026'); page.click('button:has-text("Sign in")'); page.wait_for_timeout(1500)
    page.goto(BASE + '/security/vehicles'); page.wait_for_timeout(1500)
    shot('40-vehicle-gate')
    page.keyboard.type('VEHICLE|UAX551K'); page.keyboard.press('Enter'); page.wait_for_timeout(900)
    shot('41-vehicle-scanned')
    page.keyboard.type('CARD-0300'); page.keyboard.press('Enter'); page.wait_for_timeout(1200)
    shot('42-vehicle-recorded')
    print('vehicle banner:', page.locator('.banner').first.inner_text().replace('\n', ' | ')[:120])
    page.keyboard.type('UBK 777A'); page.keyboard.press('Enter'); page.wait_for_timeout(900)
    shot('43-vehicle-unknown')
    page.keyboard.press('F4'); page.wait_for_timeout(600)
    page.locator('input.mono').nth(1).fill('VP-002')
    page.get_by_label('Driver / visitor name').fill('Kenneth Opio') if page.get_by_label('Driver / visitor name').count() else page.locator('.modal input').nth(2).fill('Kenneth Opio')
    shot('44-guest-in-modal')
    page.keyboard.press('Control+Enter'); page.wait_for_timeout(1200)
    shot('45-guest-in-done')
    print('guest banner:', page.locator('.banner').first.inner_text().replace('\n', ' | ')[:120])
    page.keyboard.type('VP-002'); page.keyboard.press('Enter'); page.wait_for_timeout(900)
    shot('46-guest-out-modal')
    page.keyboard.press('Enter'); page.wait_for_timeout(1200)
    print('guest out banner:', page.locator('.banner').first.inner_text().replace('\n', ' | ')[:120])
    shot('47-guest-out-done')

    # 3. admin on a normal PC (new context = no terminal cookie)
    ctx2 = b.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx2.new_page()
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errors.append(f'console: {m.text}'))
    page.on('response', lambda r: r.status >= 400 and errors.append(f'{r.status} {r.url}'))
    page.goto(BASE + '/'); page.wait_for_timeout(800)
    page.fill('#u', 'superadmin'); page.fill('#p', 'ChangeMe!2026'); page.click('button:has-text("Sign in")'); page.wait_for_timeout(1800)
    print('admin landed on', page.url)
    for path, name in [('/dashboard', '10-dashboard'), ('/assets', '11-assets'), ('/assets/new', '12-asset-new'), ('/assets/non-company', '13-noncompany'),
                       ('/labels?ids=1,2,3,4,5', '14-labels'), ('/staff', '15-staff'), ('/store', '16-store'), ('/store/stock', '17-stock'),
                       ('/requisitions', '18-requisitions'), ('/requisitions/1', '19-req-detail'), ('/requisitions/new', '20-req-new'),
                       ('/reception', '21-reception'), ('/reception/appointments', '22-appointments'), ('/security/investigations', '23-cases'),
                       ('/security/investigations/1', '24-case'), ('/reports', '25-reports'), ('/admin/import', '26-import'),
                       ('/admin/users', '27-users'), ('/admin/branches', '28-branches'), ('/admin/settings', '29-settings'), ('/admin/audit', '30-audit'),
                       ('/me', '31-me'), ('/assets/1', '32-asset'), ('/store/loans', '33-loans'), ('/requisitions/inbox', '34-inbox'), ('/vehicles', '35-vehicles'), ('/labels?source=vehicles&ids=1', '37-vehicle-label'), ('/store/stock', '38-stock')]:
        page.goto(BASE + path); page.wait_for_timeout(1300); shot(name)
    page.goto(BASE + '/admin/users'); page.wait_for_timeout(800); page.click('button:has-text("Roles and permissions")'); page.wait_for_timeout(800); shot('36-roles')
    b.close()
print('\n'.join(errors) if errors else 'NO BROWSER ERRORS')
