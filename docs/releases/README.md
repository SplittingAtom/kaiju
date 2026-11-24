# Release notes

Kobe was renamed Kaiju in the release after v1.4 (spec `docs/specs/rename-kaiju.md`); the release
notes before it keep the name they were written under.

Operators upgrading across the rename: log `service` fields and Postgres `application_name`s
changed from `kobe-*` to `kaiju-*` and the operator CLI is `kaiju`; see
[Upgrade notes](../install.md#upgrade-notes).

- [v1.4: Git organizations](v1.4.md)
- [v1.3: Semantic Memory](v1.3.md)
