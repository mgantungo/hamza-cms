# Asset Tracker v2 — deployment checklist

1. **Rotate secrets.** The v1 CMS `.env` was in GitHub. New APP_KEYS, JWT_SECRET, V2_JWT_SECRET,
   ADMIN_JWT_SECRET, API_TOKEN_SALT, TRANSFER_TOKEN_SALT, ENCRYPTION_KEY and a new DB password.
2. **Back up the v1 database** (`mysqldump`). v2 adds tables and columns; v1 rows are kept.
3. **CMS:** copy `cms/.env.example` to `.env`, fill it in. Put each gate's v1 location text in
   `SEED_ACCESS_POINTS[].legacy_location`. `npm install && npm run build && npm run start`.
4. **First sign-in:** open the web app, sign in as the seeded Super Admin, change the password.
   Create users (Admin › Users & roles), link each to their staff record, give guards their access points.
5. **Migrate v1 logs** once: `RUN_V1_MIGRATION=true`, restart, check the log line, set it back to `false`.
6. **Web app:** copy `app/.env.example` to `.env`, set `NUXT_API_UPSTREAM` and branding,
   `npm install && npm run build && npm run start` behind HTTPS (nginx / IIS reverse proxy).
7. **Gate PCs:** run `install-terminal.ps1 -Url https://HOST/gate`, reboot, enrol each one.
8. **Vehicles:** check the Vehicles category is marked "holds vehicles", that every vehicle has its plate, and print windshield QR labels (Labels › Vehicle windshield, Large).
9. **Labels:** print a test sheet of every size on your printer and scan it before a big run.
10. **Nightly job** runs at 20:00 server time (`CLOSE_OF_DAY_CRON`); set `TZ` on the server.
