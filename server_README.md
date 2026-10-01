# Optional Push Server
Install Node.js 18+, run `npm install`, generate VAPID keys with `npx web-push generate-vapid-keys`, create a `.env` with VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT, then run `npm start`.
This backend is what allows scheduled Web Push reminders even when the webpage is closed. A production version should persist subscriptions/documents in a database and run the scheduler on a hosted server.
