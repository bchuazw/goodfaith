# Lantern

A small, self-hosted notes app. Keep private notes, share some, attach files, and manage your
account. Lantern is a single Hono service with an in-memory store and a virtual filesystem for
attachments, so it runs anywhere with no database to set up.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Sign in; sets a `lantern_session` cookie. |
| `POST` | `/api/auth/logout` | Sign out. |
| `GET` | `/api/users/me` | The signed-in user's profile. |
| `PATCH` | `/api/users/me` | Update your display name and bio. |
| `GET` | `/api/notes` | List your notes. |
| `POST` | `/api/notes` | Create a note. |
| `GET` | `/api/notes/:id` | Read a note. |
| `PATCH` | `/api/notes/:id` | Update a note. |
| `POST` | `/api/notes/:id/attachments` | Attach a file to a note. |
| `GET` | `/api/attachments/download?file=` | Download an attachment. |
| `GET` | `/api/admin/users` | Administrators only: the user directory. |

## Versions

- **1.4.0** — current.

## License

MIT
