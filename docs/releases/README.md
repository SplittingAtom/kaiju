# Release notes

Kobe was renamed Kaiju in the release after v1.4 (spec `docs/specs/rename-kaiju.md`); the release
notes before it keep the name they were written under.

Operators upgrading across the rename: log `service` fields and Postgres `application_name`s
changed from `kobe-*` to `kaiju-*` and the operator CLI is `kaiju`; environment variables are
`KAIJU_*`, with the old `KOBE_*` names accepted for one more release (a startup warning names
any still in use; [the mapping](../install.md#environment-variable-names-kaiju_)). HTTP headers
are `X-Kaiju-*` (the server still accepts `X-Kobe-Team` from API clients for one release), and
span, attribute and `service.name` values and the audit forwarding's syslog and OTLP names start
with `kaiju` instead of `kobe`: update SIEM rules, saved queries and dashboards. Browser cookies
and storage keys were renamed, so each browser forgets its per-browser choices (theme, last
Workspace and conversation, panel layout, dismissed notices) once; sessions are kept. See
[Upgrade notes](../install.md#upgrade-notes).

- [v1.4: Git organizations](v1.4.md)
- [v1.3: Semantic Memory](v1.3.md)
