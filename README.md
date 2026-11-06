# A2Z Auto Parts

Enquiries, quotes, invoices and credit notes for a used auto parts business in the UAE.

- **web/**: the screens (Next.js and React), plus `web/server.mjs`, which runs the whole app
- **api/**: the API (Node.js and Express) that stores everything in **MongoDB**
- **wa/**: the optional WhatsApp listener and worker, which turn parts requests from WhatsApp into enquiries (see **WhatsApp intake**)
- **render.yaml**: sets it up on **Render**: the web service, plus the WhatsApp service if you use it

`web/server.mjs` runs both in one process: requests to `/api/...` and `/healthz` go to the API, and everything else goes to the screens. The browser only talks to one site, so the login cookie stays secure.

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
1. In Render: **New + → Blueprint**, connect GitHub and pick the repository. Render reads `render.yaml` and shows one service, **a2z-auto-parts-web**.
2. When it asks for values:
   - `MONGODB_URI`: the Atlas connection string from step 1.
   - `SESSION_SECRET`: any random string of 32 or more characters (for example, run `openssl rand -hex 32`). Changing it later signs everyone out.
   - `ANTHROPIC_API_KEY`: optional. It turns on "Read message into items". Leave it empty to skip.
3. Click **Apply** and wait for the deploy to finish.
4. Open the **a2z-auto-parts-web** address, choose **Create an account**, and sign up. That first account can sign in straight away.
5. Go to **Settings** and fill in the company name (exactly as on the trade licence), trade licence number, issuing authority, address and bank details. Invoices can't be issued until the name and address are set.
6. Your colleague signs up from the same sign-up page. You approve them under **Settings → Team**.

**Plan:** `render.yaml` uses Render's **Starter** plan ($7/month), which never sleeps. To try it for free, change it to `plan: free`; free services go to sleep after 15 minutes without use and take about a minute to wake.

**Own domain (optional):** in **a2z-auto-parts-web → Settings → Custom Domains**, add e.g. `app.yourcompany.ae` and follow Render's DNS steps.

## WhatsApp intake (optional)

Reads the business WhatsApp and turns parts requests into enquiries, so nobody has to paste messages by hand.

**How it works**

1. **Listener** (`wa/src/listener.js`). Joins WhatsApp as a linked device, like WhatsApp Web, using [Baileys](https://github.com/WhiskeySockets/Baileys). It saves every incoming message, photo and voice note to MongoDB. It **only reads**: it never sends, reacts or marks chats as read. Its login is kept in MongoDB, so deploys don't unlink it.
2. **Batching.** Messages from one chat that arrive close together (text, then a photo, then a voice note) are read together. A chat's batch is read once it has been quiet for 90 seconds, or 10 minutes after its first message at the latest.
3. **Worker** (`api/src/wa/processor.js`). Transcribes voice notes (OpenAI Whisper, or Deepgram), then sends the text, transcripts and up to 6 photos to Claude. Claude decides whether it's a parts request, a reply to a quote or something else, and lists the items with a confidence score.
4. **Enquiry or review.**
   - It becomes an enquiry by itself, marked "via WhatsApp", with the photos and the original messages attached, when all of these hold:
     - the chat belongs to a known workshop;
     - it is a parts request;
     - Claude is at least 85% sure (`WA_AUTO_CONFIDENCE`).
   - Anything else waits in the new **WhatsApp** tab. There you can fix the items, pick the workshop and press **Create enquiry**, or **Set aside**.
   - Replies to quotes and chit-chat are set aside, not turned into enquiries.
5. **Your own team's messages.** The linked phone's own messages are ignored. If salespeople reply in workshop groups from other numbers, list those numbers under **Settings → Your company → Our team's WhatsApp numbers**. Their messages are then kept for the record but never read as requests.
6. **VINs.** A VIN in a message (17 characters) is looked up in the free US government decoder (NHTSA vPIC). The make, model, year and engine are given to the reader and written into the enquiry notes. If the decoder can't be reached, the model year is still read from the VIN itself and marked as "probably".
7. **Matching chats to workshops.** A chat matches a workshop by its **WhatsApp group name** (Customers → Edit, exactly as the group is named; separate several with commas). A direct chat matches by the workshop's **phone number**. When you pick a workshop for an unmatched chat in the WhatsApp tab, the app remembers it.
8. **Records.** Raw messages are kept in `wa_messages`, and voice notes in `wa_media`. Photos are kept in `photos`, alongside the ones uploaded in the app. Every automatic and manual decision is logged in `wa_audit`. MongoDB is the queue (`wa_batches`): each batch is claimed atomically, retried up to 3 times, then shown as "Couldn't read".

**Set it up**

1. In Render, the Blueprint now also shows **a2z-whatsapp** (a background worker, Starter plan, $7/month). Fill in:
   - `MONGODB_URI`: the same value as the web service.
   - `ANTHROPIC_API_KEY`.
   - `OPENAI_API_KEY` for voice notes, or `DEEPGRAM_API_KEY`.
2. Open the app → **WhatsApp**. When the service is running, it shows a QR code. On the business phone, go to WhatsApp → **Settings → Linked devices → Link a device** and scan it.
3. Under **Customers**, fill in each workshop's **WhatsApp group name** (and phone number for direct chats).
4. Watch the WhatsApp tab for a few days. If what it creates by itself looks right, keep 0.85. To check everything by hand, set `WA_AUTO_CONFIDENCE` to `off`.

**Be aware**

- Baileys is **not an official WhatsApp product**. WhatsApp can restrict numbers that use unofficial clients.
  - Reading only (as here) is much lower risk than sending, but it is not zero.
  - Keep the phone itself in normal use, and don't run two copies of the service.
  - If the number matters a lot to the business, keep a backup way for workshops to reach you.
- Messages, photos and voice notes from workshops go to Anthropic (Claude) and to OpenAI or Deepgram for reading. Tell workshops if your terms require it.
- If the phone unlinks the device, the WhatsApp tab shows a new QR code to scan. Messages that arrive while the service is off are picked up when it reconnects, for up to 3 days.

**Run it on your computer:** `cd wa && npm install && npm run dev`. It reads `api/.env` and shows the QR code in the app's WhatsApp tab at http://localhost:3000/whatsapp.

## Run on your computer

You need Node.js 22 or newer and a MongoDB connection string (Atlas works).

```bash
cd api
cp .env.example .env        # fill in MONGODB_URI and SESSION_SECRET
npm install
cd ../web
npm install
npm run dev                 # open http://localhost:3000 (reads its settings from api/.env)
```

API tests use an in-memory stand-in for MongoDB, so no database is needed: `cd api && npm test`.

## Moving data from the Claude page

To bring records across from the A2Z Auto Parts page in Claude, ask Claude for a JSON export of that page's data. Then use **Settings → Records and backups → Import a backup**. Records that already exist are kept as they are, and numbering continues after the highest imported number.

## Keeping records

Keep every invoice and credit note for at least 7 years (the Corporate Tax record rule). Each month:
- **Settings → Export invoices and credit notes (CSV)**
- **Settings → Download full backup (JSON)**
- Save the month's invoice PDFs

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
| GET | /api/wa/status, /api/wa/inbox?view= | signed in | WhatsApp connection, QR code, and read messages |
| POST | /api/wa/batches/:id/accept, /dismiss, /retry | signed in | make a WhatsApp request an enquiry, set it aside, read it again |
| GET | /api/wa/batches/:id/audit, /api/wa/media/:id | signed in | decision log, voice notes |
| GET/POST | /api/export, /api/import, /api/sample/clear | signed in | backups and sample data |
| GET/PATCH/POST | /api/team | signed in | approve people, turn accounts off, reset passwords |
