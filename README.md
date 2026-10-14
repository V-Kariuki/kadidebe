# Kadidebe — Multi-Tenant Election Monitoring (Prototype)

Parallel election monitoring for Kenya, built so a single deployment can
serve many independent clients — each with its own isolated data, its own
jurisdiction ceiling, and its own set of enabled features.

## Tenancy model

**Geography is shared. Operations are isolated.**

The national register (counties → constituencies → wards → registration
centres → polling stations) is one shared dataset every instance reads.
Duplicating 46,000 polling stations per client would be wasteful and a
data-integrity hazard.

Everything operational — process events, ballot custody, results, turnout,
incidents, evidence, activity, audit, and agent assignments — carries a
`tenant_id`. Two candidates monitoring the same ward read the same polling
stations but keep entirely separate tallies and never see each other's data.

**Jurisdiction ceiling.** Each instance is capped at national / county /
constituency / ward. Users inside it can never see or act outside that
ceiling regardless of their own role.

**Modules.** Ten features can be switched on or off per instance (two are
core and always on). An MCA instance need not carry presidential tallying.

**Races.** Each instance declares which of the six elective positions it
tracks; submissions for any other race are rejected server-side.

## Roles

| Role | Scope |
|---|---|
| `superadmin` | Platform-wide. No instance of their own. Provisions instances and is the **only** role that may edit the shared register. |
| `admin` | Full control within one instance, up to its ceiling. |
| `coordinator` | Ward / constituency / county / national, within the instance ceiling. |
| `agent` | Only the streams they're assigned to. |
| `aspirant` | View-only within the instance. |

## Run locally

```
cd server && npm install && npm run seed && npm start      # http://localhost:4000
cd client && npm install && npm run dev                    # http://localhost:5173
```

`npm run seed` prints every demo account. Highlights:

- **Platform:** `superadmin@kadidebe.ke` / `Platform!Admin1`
- **Three demo instances** with deliberately different shapes:
  - `muriithi-governor` — county ceiling, all races, all modules
  - `mworia-mp` — constituency ceiling, 3 races, audit off
  - `kaburu-mca-chuka` — single ward, MCA only, seal custody + booklets + reports + audit off

All three use the **same** admin email (`admin@kadidebe.ke` / `ChangeMe!Admin1`)
— that's intentional: email is unique per instance, so sign-in asks which
instance you mean.

## Try this

1. Sign in as `superadmin@kadidebe.ke` → **Instances** → provision a new one,
   pick a ward ceiling, switch modules off, set its races, give it an admin.
2. Sign in as that new admin — they see only their ward, and disabled
   features aren't in the sidebar at all.
3. Sign in to `kaburu-mca-chuka` and `muriithi-governor` in two browsers.
   Both can open the same Chuka polling stream. Log an event or turnout in
   one; the other is unaffected.

## Before production

- Evidence files write to local disk (`server/uploads/`). Most hosts wipe
  this on redeploy — move to object storage.
- Set a real `JWT_SECRET`.
- The register import (`/api/register/import`) is superadmin-only and takes
  the IEBC "Registered Voters per Polling Station" CSV: 46,220 rows in ~1s.
