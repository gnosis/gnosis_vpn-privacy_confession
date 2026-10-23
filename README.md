# Privacy Confessions

> **Status:** Event prototype — not production-hardened.

Anonymous confession wall for DappCon 2026. Submissions appear on the wall straight away; admins can delete them afterwards.

## Pages

- `/` — submit a confession (up to 1000 characters)
- `/wall` — public display, polls for confessions every 10 seconds
- `/admin` — moderation panel (password protected)

## Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL via [Neon](https://neon.tech)
- **Hosting:** Vercel
- **Frontend:** Vanilla HTML/CSS/JS — no build step

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string (use the pooled URL) |
| `ADMIN_PASSWORD` | Admin panel password |

## Running locally

```bash
npm install
```

Create a `.env` file (never committed):
```
DATABASE_URL=postgresql://...
ADMIN_PASSWORD=your-password
```

```bash
npm start
```

The database tables are created automatically on first run.

## Deploying to Vercel

1. Push to GitHub
2. Import the repo in Vercel
3. Add `DATABASE_URL` and `ADMIN_PASSWORD` in **Settings → Environment Variables**
4. Deploy

## Admin panel

Visit `/admin` and enter the admin password.

- **Confessions** — everything on the wall; delete removes it
- **Download DB** — full JSON backup of all confessions and emails
- **Download emails** — CSV of voucher signups
