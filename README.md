# Kadidebe — Parallel Election Monitoring

Full rebuild covering the counties -> constituencies -> wards -> polling
stations -> streams hierarchy, an event-sourced status timeline, ballot
box/seal/booklet custody, results submission with required photo evidence,
live turnout snapshots, incident reports with image/video/audio evidence,
and jurisdiction-scoped coordinator approval.

## Run locally

### Backend

```
cd server
npm install
cp .env.example .env   # edit JWT\_SECRET etc. if you want
npm run seed            # creates data/election.db with demo accounts
npm start                # http://localhost:4000
```

### Frontend

```
cd client
npm install
npm run dev              # http://localhost:5173, proxies /api and /ws to :4000
```

## Demo accounts (all password shown, all @kadidebe.ke)

|Email|Password|Role|
|-|-|-|
|admin@kadidebe.ke|ChangeMe!Admin1|admin (national)|
|national@kadidebe.ke|national2027|coordinator (national)|
|county@kadidebe.ke|county2027|coordinator (Tharaka Nithi county)|
|coordinator@kadidebe.ke|honeycomb2027|coordinator (Tharaka constituency)|
|ward.chuka@kadidebe.ke|ward2027|coordinator (Chuka ward)|
|aspirant@kadidebe.ke|aspirant2027|aspirant — view-only, Tharaka Nithi county|
|<agent-name>@kadidebe.ke|agent2027|agent (one per ward — see seed.js console output)|
|peter.pending@kadidebe.ke|pending2027|pending — requested agent in Mariani ward|
|grace.pending@kadidebe.ke|pending2027|pending — requested admin (only admin@ can approve)|

## Try this walkthrough

1. Log in as `coordinator@kadidebe.ke` -> Users -> approve `peter.pending@kadidebe.ke` as an agent.
2. Log in as any `<agent>@kadidebe.ke` -> Stations -> open a stream -> log timeline events, walk through the full ballot box seal lifecycle (log serial -> confirm empty -> seal with IEBC + agent seals -> closing seal at close -> seal-match confirmation at tally start -> re-seal after count), log a turnout snapshot (only while polling is open), log booklets (only after polling opens, with a ballot count), then go to Results (sidebar) once tallying has started and submit results with full ballot accounting.
3. Try entering numbers that don't reconcile in the results form — you'll get a warning and a "File incident report" button that pre-fills an urgent incident.
4. Log in as `admin@kadidebe.ke` -> Team \& Structure to see the counties/constituencies/wards/stations structure and cross-ward team assignment (a stream can now have multiple agents, and an agent can cover multiple streams).
5. Log in as `ward.chuka@kadidebe.ke` (a ward coordinator) -> Users -> try reassigning an agent (works, since a ward coordinator outranks agents) vs. reassigning another coordinator (blocked — needs constituency level or above).
6. Overview page updates live via WebSocket, has a jurisdiction scope selector (try narrowing to a specific ward/constituency/county), and shows a pending-approvals callout for coordinators.
7. Log out and visit the app root while logged out to see the new marketing landing page.
8. Toggle dark/light theme from Profile (sidebar -> Profile).

## Before deploying

* Evidence files (result photos, incident media) are currently written to local disk (`server/uploads/`). Most hosts (Render free tier included) wipe local disk on redeploy/restart — swap this for real object storage (S3, Cloudinary, etc.) before relying on this in production.



