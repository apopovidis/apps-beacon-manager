# Mounting `/beacon` on a product's own web app

1. Copy `beacon.html` into the web app, replacing `MANAGER_ORIGIN` and `PRODUCT_ID` in the iframe `src` with the real Manager origin and this product's id (from Manager's Products view).
2. Serve it at `/beacon`:
   - **Static hosting** (Netlify, S3, GitHub Pages, etc.) — put the file at `beacon.html` in your public output; most static hosts map `/beacon` to `/beacon.html` automatically, or add an explicit redirect rule.
   - **Express** — `app.get("/beacon", (req, res) => res.sendFile("beacon.html"))`.
   - **Next.js** — drop it in `public/beacon.html`; Next serves static files under `public/` at the root path automatically.
3. Create a login for the agency/team member in Manager's "Embed access" dialog on that product (a username + password — separate from Manager's own admin key and from Beacon's own admin key, and scoped to only this product's projects).

Nothing else needs to run on the host app — the real dashboard, login, and scoping enforcement all live on Manager. This file is a thin pointer, not a copy of any logic.
