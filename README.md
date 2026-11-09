# HM Mixes Order

Daily mix ordering for all HM stores, replacing the shared “Mixes Orders” Excel workbook.

- **Stores** open one link, pick their branch, enter their PIN and type tomorrow’s quantities (English / العربية, works on phones).
- **Every day at 6:30 PM (Riyadh)** the open sheet locks and is hidden from stores. Stores that didn’t submit get their previous day copied, anomaly checks run, and the next day opens.
- **Admins** see every day (like the hidden sheets), fix problems, manage stores/items/formulas, and **download the workbook** in the original layout: one sheet per day, all hidden except the latest, `=J4*$K$3` formulas and SUM totals.

Runs entirely on Cloudflare’s free plan: Workers (app + API), D1 (database) and Cron Triggers (the 6:30 PM job).

---

## One-time setup (about 10 minutes, no coding)

### 1. Create the database
1. Log in to <https://dash.cloudflare.com>.
2. Left menu → **Storage & databases → D1 SQL database → Create database**.
3. Name it **`hm-mixes-db`**, then click **Create**.
4. Put its **Database ID** in `wrangler.jsonc` (`database_id`). This is already done for the current database `b3e922e4-…`. Only change it if you create a new database.

### 2. Connect the GitHub repo to Cloudflare
1. Left menu → **Workers & Pages → Create → Import a repository** (or “Continue with GitHub”).
2. Authorise GitHub and pick **`shandrif/hm-mixes-order`**.
3. Settings:
   - Project name: `hm-mixes-order`
   - Production branch: the branch holding this code (`main` once merged)
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
4. Click **Deploy**. When it finishes you get a link like `https://hm-mixes-order.<your-account>.workers.dev`.

From now on every push to that branch redeploys automatically. The database tables are created automatically on first use.

### 3. Create the admin account
Open `https://…workers.dev/admin`. On the first visit it asks you to choose an admin email and password. The first person to do this becomes the admin, so do it right after the first deploy. You can add more admins later under Settings → Admins.

(Optional alternative: set `ADMIN_EMAIL` / `ADMIN_PASSWORD` as Worker secrets. The first-visit screen is then turned off.)

### 4. Load the current workbook
1. Open `https://…workers.dev/admin` and sign in.
2. **Excel → Import existing workbook** → choose the latest `Mixes_Orders_*.xlsx`.
3. Review the suggestions (store spelling merges, sheets that share a date), then click **Import**.
   All sheets, including hidden ones, become history, and every day is checked for problems.
4. **Stores → Download PIN list** and send each store its PIN. Share the main link (`https://…workers.dev`) with all stores.

---

## How it works

| Thing | Behaviour |
|---|---|
| Order day | The sheet dated **D** accepts entries from D-1 18:30 until D 18:30 (Riyadh). Change the time under Settings. |
| Cutoff | A cron job runs every 15 minutes and locks any day past its cutoff. Entries after the cutoff are refused even if the job runs late. |
| No submission | At lock time, the store’s previous-day quantities are copied (marked “copied”, shown in blue in the sheet, reported as info). Three or more days in a row creates a warning. |
| Calculated items | Items such as *Cookie Topping = Vanilla × 480*. Change the multiplier or source item under **Items**. Exported as real formulas. An admin can type over one cell (shaded orange, flagged), and clearing it restores the formula. |
| Adding/removing stores or items | Applies to the open day and every day after. Locked days keep the names and columns they had. |
| Excel download | Blocked while **critical** anomalies are open, unless the admin ticks “Download anyway”. |

### Anomaly checks
- **Critical:** quantity far above that store’s normal (e.g. 40 instead of 4), or an invalid quantity (negative, or 0.05 when the step is 0.5).
- **Warning:** calculated cell typed over, item total far above average, store not submitting for 3+ days, text in a quantity cell, sheet date mismatch, and similar.
- **Info:** store copied forward, unusual 0, blank cell, total formula that skipped rows (fixed automatically), stray characters, merged store spellings.

Fixing a cell re-runs the checks for that day. Findings can also be marked fixed or ignored (with a note), one at a time or in bulk.

---

## Branding
Colours are taken from the current workbook (gold `#D4B38B`, cream `#F5EDE3`, mint `#84C6B2`, charcoal). To apply the official HM brand:
- Replace `public/logo.svg` with the HM logo.
- Edit the colour variables at the top of `src/styles.css`.

## Development
```bash
npm install
cp .dev.vars.example .dev.vars   # local admin login
npm run dev                      # builds the web app and runs the Worker + local D1 on http://127.0.0.1:8787
npm test                         # unit + integration tests
```
To test the importer against a real file: `HM_XLSX=/path/to/Mixes_Orders.xlsx npx vitest run tests/import.local.test.ts`.

```
worker/      Cloudflare Worker: API, auth, 6:30 PM rollover, anomaly runs (index.ts, data.ts)
shared/      Code used by both sides: anomaly rules, date/cutoff maths, types
src/         React web app: store page, admin pages, Excel import/export (src/excel)
tests/       Vitest tests (cutoff + carry-forward against a local D1, rules, Excel round-trip)
```
