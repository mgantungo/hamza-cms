# Asset Tracker v2 — CMS / API (Strapi 5)

One Strapi API and one MySQL database serve every branch. All v2 endpoints live under
`/api/v2` and are protected by the `global::authorize` policy (JWT + role permissions).

## First run

```bash
cp .env.example .env        # fill in NEW secrets and the database
npm install
npm run build               # Strapi admin panel
npm run start               # or: npm run develop
```

On first start the bootstrap (`src/v2/seed.js`) creates, only if missing:

- the 11 built-in roles (Super Admin … Staff) with their permissions
- the first Super Admin from `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` — sign in and change it
- a branch, its access points (`SEED_ACCESS_POINTS`), a Main Store, an office and visitor badges
- departments (from the v1 list) and asset categories
- links every v1 staff record to a department record, and marks every v1 asset as company-owned

Set `RUN_V1_MIGRATION=true` once to convert v1 records: `access-log` rows (devices JSON) and
`vehicle-access-log` rows become `movement` rows, `anomaly` rows become investigation cases, and
guest `entrance-session` rows become visits. v1 vehicles (category "vehicle", plate in the tag)
are linked to the Vehicles category on every start, with the plate copied to the plate field. Map old location strings by giving each access point a
`legacy_location` in `SEED_ACCESS_POINTS` (or in Admin › Branches & terminals before running it).
It runs once; set it back to `false` afterwards.

## Security notes

- The v1 `.env` with real secrets was committed to GitHub. **Rotate every secret** (APP_KEYS,
  JWT secrets, database password) and keep `.env` out of git (`.gitignore` is fixed).
- The v1 shared-password endpoint `/api/auth/entrance-login` is removed. Everyone signs in with
  their own account.
- Every v1 public REST route (`/api/company-assets`, `/api/staffs`, `/api/vehicle-access-logs` …) is closed.
  The only API is `/api/v2`, and every route needs a signed-in user with the right role
  (except sign-in and terminal enrolment, which check credentials themselves).

## Layout

```
src/v2/lib.js              auth, RBAC, branch scoping, audit, numbering, case helper
src/v2/seed.js             roles, first admin, reference data, v1 migration
src/v2/handlers/*.js       auth/terminals, generic resources, gate, reception, assets,
                           cases (investigations), store, requisitions, reports, imports
src/api/v2/routes/v2.js    every v2 route with its required module/action
src/policies/authorize.js  JWT + permission check
config/cron-tasks.js       nightly close-of-day: overstays, unreturned badges, overdue loans
src/api/<collection>/      22 new collections + 5 extended v1 ones
```

## Vehicles

Vehicles are assets in a category marked "holds vehicles"; the plate lives in `serial_number`
(upper case, no spaces). The vehicle gate (`/api/v2/vehicle-gate/*`) reads windshield QR codes in
the agreed format `{"assetId":"UAX551K","assetType":"vehicle","recordId":12}` (and v1's
`VEHICLE|UAX551K`), records movements in the same log as items, checks the driver against the
assigned driver, and runs guest vehicles on the passcard pool (`SEED_PASSCARDS`, default 20).

## Tests

```bash
DATABASE_CLIENT=sqlite npm run start   # fresh .tmp/data.db
npm run test:smoke                     # 82 end-to-end API checks
node tests/import_test.mjs             # Excel import with row errors
node tests/route_audit.js ../app       # every web-app API call, resource, link and nav entry
                                       # has a matching CMS route / page
```

## Optional integrations

`SMS_WEBHOOK_URL` — receives `POST {to:[{phone,email}], title, body}` for host notices,
visitor invites and approval requests. Point it at your SMS/email gateway.
