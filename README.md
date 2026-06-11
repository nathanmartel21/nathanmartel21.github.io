# nathanmartel21.github.io

Personal website of Nathan Martel — dark engineering-themed portfolio, blog, and a
custom "Strava Premium" running dashboard built on the official Strava API.

## Structure

- `index.html` — one-page portfolio (hero with terminal card, about, blog preview, contact).
- `pages/blog.html` — blog listing, driven by `pages/blog-posts/posts.json`.
- `pages/blog-posts/` — individual articles and their images.
- `styles/style.css` — shared design system for the portfolio and blog.
- `strava/` — the Strava Premium app:
  - `index.html` — landing + OAuth setup/connection page (also the OAuth callback).
  - `app.html` — the dashboard (charts, records, run-of-the-day suggestion, goals).
  - `js/` — `auth.js` (OAuth2), `api.js` (Strava client + local cache), `analysis.js`
    (stats, CTL/ATL/TSB fitness model, pace zones, suggestion engine), `demo.js`
    (synthetic data for demo mode), `app.js` (rendering), `config.js` (storage).
  - `css/strava.css` — app theme (Strava orange).

## Strava app setup (one time)

1. Create an API application on <https://www.strava.com/settings/api> with
   *Authorization Callback Domain* set to `nathanmartel21.github.io`
   (use `localhost` when testing locally).
2. Open `/strava/`, paste the Client ID and Client Secret, and click
   *Se connecter avec Strava*.

Everything runs client-side: tokens, credentials and the activity cache stay in the
browser's localStorage and only ever talk to `www.strava.com`. A demo mode with
generated data is available without any account.

## Adding a blog post

Add the article HTML under `pages/blog-posts/` and append an entry to
`pages/blog-posts/posts.json` (title, subtitle, tags, date, readTime, href).
