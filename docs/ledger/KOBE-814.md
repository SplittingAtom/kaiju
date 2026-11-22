# KOBE-814: Kobe admin limits in the Site console and API

- **Branch:** `group-87-rl-admin-settings`
- **Change:** `GET/PUT /v1/site/settings` carry `kobeReadsPerMinute` (default 60) and
  `kobeWritesPerHour` (default 30), integers 1-10000, under `site.settings.manage`. Stored in
  `site_settings` (`kobe_mcp.reads_per_minute`, `kobe_mcp.writes_per_hour`); no migration.
  Audited as `site.settings.updated` with `setting` `kobe_reads_per_minute` / `kobe_writes_per_hour`
  (new enum values; row updated in `docs/audit-log.md`); an unchanged value writes no event.
- **No restart:** `withinKobeLimit` reads the setting on every call; nothing caches it.
- **Console:** Site console > Settings > "Kobe admin limits" form, defaults in the hints.
- **Docs:** guide `admin/site-admin.md` and `admin/admin-from-a-conversation.md` updated.
- **For docs/rate-limits.md (PR #682):** replace "no route or console page writes them" for
  `kobe_mcp.reads_per_minute` / `kobe_mcp.writes_per_hour` with "Site console > Settings > Kobe
  admin limits, or `PUT /v1/site/settings` (`kobeReadsPerMinute`, `kobeWritesPerHour`), 1-10000".
