# A2Z Auto Parts

Enquiries, quotes, invoices and credit notes for a used auto parts business in the UAE.

- **web/**: the screens (Next.js and React)
- **api/**: the server (Node.js and Express) that stores everything in **MongoDB**
- **render.yaml**: sets both up on **Render** in one go

The web app forwards every `/api/...` request to the API, so the browser only talks to one site and the login cookie stays secure.

## What it does

- **Enquiries.** Each enquiry can have several items, and each item can have several options (Used, Aftermarket or Original), each with its own lead time, cost, price and discount. Photos are stored in MongoDB, shrunk in the browser before upload.
- **Quotes.** Numbered QT-0001 onwards, with revisions (QT-0006-R2). There's a PDF and a WhatsApp text where the workshop replies with codes like "1A 2B".
- **Invoices.** Created from a quote by ticking items, the chosen option and the quantity. Part invoicing is allowed.
  - Numbers run in sequence and are assigned on the server, so two people can never get the same one.
  - Seller, buyer and lines are copied into the invoice when it's issued, and an issued invoice can't be edited or deleted.
- **Credit notes.** Cancelling an invoice issues CN-0001 onwards. The invoice stays on record marked cancelled, and its items can be invoiced again.
- **Payments.** Cash, bank transfer, cheque or card, including part payments. Overdue invoices are flagged.
- **Delivery tracking.** A due date is worked out from the lead time, and you tick items off as they're delivered.
- **Dashboard.** Shows what needs pricing, quotes awaiting reply, orders to invoice, deliveries due or late, sales, profit, unpaid invoices, commission and the VAT registration threshold.
- **Not VAT-registered wording.** Documents are titled "Quotation", "Invoice" and "Credit note", with no VAT and no supplier TRN, and they say "Supplier not registered for VAT". Each invoice shows the trade licence number, the customer's TRN if they have one, the date of supply, the due date and the amount in words.
- **Accounts.**
  - **Everyone has the same access.** There are no roles: every user sees costs, margins and commission, manages settings and the team, and can cancel invoices.
  - The **first account created** can sign in straight away. Later sign-ups wait until someone already on the team approves them in Settings → Team.
- **Records.** CSV export of invoices and credit notes, a full JSON backup, import of a backup, and sample data you can load and remove.

## Deploy

### 1. MongoDB Atlas (free tier is fine to start)
1. Sign up at mongodb.com/atlas and create a cluster. **M0 Free** is enough to start. Pick **AWS, Frankfurt (eu-central-1)**, the same region as Render below.
2. **Database Access** → add a database user with a strong password.
3. **Network Access** → add `0.0.0.0/0`. Render's addresses change, so the database relies on the user and password instead.
4. **Connect → Drivers** → copy the connection string and put your user's password into it:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

### 2. GitHub
Create a **private** repository and push this folder to it.

### 3. Render
1. In Render: **New + → Blueprint**, connect GitHub and pick the repository. Render reads `render.yaml` and shows two services.
2. When it asks for values:
   - `MONGODB_URI`: the Atlas connection string from step 1.
   - `ANTHROPIC_API_KEY`: optional. It turns on "Read message into items". Leave it empty to skip.
   - `API_URL`: enter `https://a2z-auto-parts-api.onrender.com` for now. You'll check it in step 4.
3. Click **Apply** and wait for both services to finish deploying.
4. Open the **a2z-auto-parts-api** service and copy its address from the top of the page. If it's different from what you entered, go to **a2z-auto-parts-web → Environment**, set `API_URL` to that address, and save. No rebuild is needed.
5. Open the **a2z-auto-parts-web** address, choose **Create an account**, and sign up. That first account can sign in straight away.
6. Go to **Settings** and fill in the company name (exactly as on the trade licence), trade licence number, issuing authority, address and bank details. Invoices can't be issued until the name and address are set.
7. Your colleague signs up from the same sign-up page. You approve them under **Settings → Team**.

**Plans:** `render.yaml` uses Render's **free** plan. Free services go to sleep after 15 minutes without use and take about a minute to wake. For daily business use, change both services to **Starter** in Render, either in the dashboard or with `plan: starter` in `render.yaml`.

**Own domain (optional):** in **a2z-auto-parts-web → Settings → Custom Domains**, add e.g. `app.yourcompany.ae` and follow Render's DNS steps.

## Run on your computer

You need Node.js 20 or newer and a MongoDB connection string (Atlas works).

```bash
# terminal 1
cd api
cp .env.example .env        # fill in MONGODB_URI and SESSION_SECRET
npm install
npm run dev                 # http://localhost:4000

# terminal 2
cd web
cp .env.example .env.local  # API_URL=http://localhost:4000
npm install
npm run dev                 # open http://localhost:3000
```

API tests use an in-memory stand-in for MongoDB, so no database is needed: `cd api && npm test`.

## Moving data from the Claude page

To bring records across from the A2Z Auto Parts page in Claude, ask Claude for a JSON export of that page's data. Then use **Settings → Records and backups → Import a backup**. Records that already exist are kept as they are, and numbering continues after the highest imported number.

## Keeping records

Keep every invoice and credit note for at least 7 years (the Corporate Tax record rule). Each month:
- **Settings → Export invoices and credit notes (CSV)**
- **Settings → Download full backup (JSON)**
- save the month's invoice PDFs

MongoDB Atlas paid tiers also offer automatic backups.

## E-invoicing

The UAE e-invoicing mandate applies to B2B invoices from **1 July 2027** for businesses under AED 50 million revenue, with an Accredited Service Provider appointed by **31 March 2027**. Check with your accountant whether and how it applies to you. Invoices here are stored as structured records (seller, buyer, lines, totals), so they can be sent to a provider later.

## API overview

| Method | Path | Who | What |
|---|---|---|---|
| POST | /api/auth/signup, /login, /logout, /password | anyone / signed in | accounts |
| GET | /api/bootstrap | signed in | everything the screens need |
| PUT | /api/settings/company | signed in | company details |
| POST/PUT/DELETE | /api/customers | signed in | workshops |
| POST/PUT/DELETE | /api/enquiries | signed in | enquiries |
| POST | /api/enquiries/:id/quote, /revise, /confirm, /lost, /reopen | signed in | quote steps |
| POST | /api/enquiries/:id/invoices | signed in | issue an invoice from the quote |
| POST | /api/invoices/:id/payments | signed in | record a payment |
| POST | /api/invoices/:id/cancel | signed in | cancel with a credit note |
| PATCH | /api/invoices/:id/commission | signed in | commission paid |
| POST/GET | /api/photos | signed in | photos |
| POST | /api/ai/read | signed in | read a WhatsApp message into items (optional) |
| GET/POST | /api/export, /api/import, /api/sample/clear | signed in | backups and sample data |
| GET/PATCH/POST | /api/team | signed in | approve people, turn accounts off, reset passwords |
