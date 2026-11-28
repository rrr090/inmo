# Setting up accounts (Supabase)

inmo's accounts are optional. With the values in `src/supabase-config.js` empty, the app runs without them and Settings → Account says so. The project used by the released app is already set up; these steps are for your own copy.

## 1. Create the project

1. Sign in at [supabase.com](https://supabase.com) and create a new project. The free tier is enough to start.
2. In **SQL Editor → New query**, paste all of [`schema.sql`](schema.sql) and run it. It creates the `profiles` table with row-level security, the trigger that makes a profile for each new account, `delete_my_account()`, the sync tables, and the friends tables and functions (`friendships`, `statuses`, `friend_signals`, `friend_add()` and the rest). It also adds `statuses` and `friend_signals` to the `supabase_realtime` publication, so the app hears about friends' status changes and new requests at once. On a project set up before friends existed, run the whole file again: it only adds what's missing, and gives existing accounts a friend code. The dashboard warns that it is destructive because of its `drop … if exists` lines; on a new project they have nothing to drop.
3. In **Authentication → URL Configuration**, set the **Site URL** to the page the confirmation link should land on (inmo uses its GitHub page). The default, `http://localhost:3000`, shows a browser error.

## 2. Connect the app

Copy the **Project URL** (the project's home page) and the **Publishable key** (Project Settings → API Keys) into `src/supabase-config.js`. Both are safe to commit and ship: the key only allows what the row-level security rules in `schema.sql` allow. Never put a secret (`sb_secret_…`) or service_role key in the app.

Then `npm start`, open Settings, and create an account. Supabase emails a link; click it, then sign in in the app.

## 3. Later: your own email sender, and 6-digit codes

Supabase's built-in email is for trying things out: it sends a few emails an hour, carries only a link, and its templates can't be changed. Before other people sign up:

1. Create an account with an email service (Resend, Postmark, Brevo and Amazon SES all work; most have a free tier) and enter its SMTP details in **Authentication → Emails → SMTP Settings**.
2. In **Authentication → Emails → Templates**, add the code to two templates:
   - **Confirm sign up**: `<h2>Confirm your inmo account</h2><p>Your code is <b>{{ .Token }}</b>. It expires in an hour.</p>`
   - **Reset password**: `<h2>Reset your inmo password</h2><p>Your code is <b>{{ .Token }}</b>. If you didn't ask for this, ignore this email.</p>`
3. Set `EMAIL_CODES = true` in `src/supabase-config.js`. The app then asks for the code instead of the link, and shows "Forgot password?".
