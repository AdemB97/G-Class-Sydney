# Setting up G Class Crew

About 15 minutes, once. Everything here is on free plans.

## 1. Create the database (Supabase)

1. Go to supabase.com, sign up, and click **New project**. Name it `gclass-crew`, pick a strong database password (keep it somewhere safe), and choose the **Sydney** region.
2. When the project is ready, open **SQL Editor** in the left menu, click **New query**, paste everything from `supabase/schema.sql`, and press **Run**. It should say "Success. No rows returned".
3. Open **Project Settings → API** (or **Connect**) and copy:
   - the **Project URL** (looks like `https://abcd1234.supabase.co`)
   - the **anon / publishable** key
   
   Send both to Claude, or paste them into `config.js`. Never share the **service_role** key.

## 2. Put the app online (GitHub Pages)

1. On GitHub, create an empty repository (this one is `G-Class-Sydney`) (no README).
2. Claude pushes the code to it.
3. In the repository, go to **Settings → Pages**, set **Source** to "Deploy from a branch", choose `main` and `/ (root)`, and save. After a minute the app is live at `https://<your-github-username>.github.io/G-Class-Sydney/`.

## 3. Tell Supabase where the app lives

In Supabase, open **Authentication → URL Configuration**:
- **Site URL**: your app link from step 2
- **Redirect URLs**: add the same link

This makes the "confirm your email" and "reset password" emails open the app.

## 4. First sign-ins

1. **Ahmed signs up first.** The first account ever created becomes the owner automatically.
2. Send the app link to the drivers. Each one taps **Create an account**, using the name they go by on run sheets (Sammy, Michael I, Oussaama B, Adem). Supabase emails them a confirmation link.
3. Ahmed opens **Staff** and taps **Approve** for each person.
4. On iPhone: open the link in Safari, tap **Share → Add to Home Screen**. On Android: Chrome menu → **Add to Home screen**. It then opens like an app.

## Changing the look

All colours and fonts live in `theme.css` (plus the font link in `index.html`). Swap those to apply a new brand; nothing else needs touching.

## Good to know

- Supabase's free plan pauses a project after a week with no activity. Normal daily use keeps it awake.
- Free storage is 1 GB for photos, which is roughly 3,000 to 5,000 car photos at the size the app saves them.
- Notifications currently appear inside the app (bell icon, live pop-ups). Phone push alerts are the planned next step.
