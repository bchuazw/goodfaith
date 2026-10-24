# Changelog

## 1.4.1

### Security

This is a security release. Everyone running 1.4.0 or earlier should upgrade.

- **Notes: enforce ownership on read (CWE-639).** `GET /api/notes/:id` returned any note to any
  authenticated user, so a user could read another user's private notes by their id. Reads are now
  restricted to the note's owner (or an administrator), and other ids return 404.
- **Attachments: contain the download path (CWE-22).** `GET /api/attachments/download` joined the
  requested name onto the upload directory without checking the result, so a name such as
  `../secrets.env` could read files outside the upload directory. The resolved path is now rejected
  unless it stays inside the upload directory.
- **Profile: stop mass assignment of privileged fields (CWE-915).** `PATCH /api/users/me` applied
  the whole request body to the user record, so a user could set `role: "admin"` and gain access to
  the administrator-only user directory. Only the editable profile fields (display name, bio, email)
  are now copied.

With thanks to the security researchers who reported these issues.

## 1.4.0

- Attachments: upload and download files on a note.
- Administration: a user directory for administrators.

## 1.3.0

- Initial public release: users, sessions, notes and sharing.
