# ACL online

App: https://ninhbao.github.io/CONGTY-ACL/

GitHub Pages serves only the interface. Supabase Auth handles sign-in; the `acl-api` Edge Function validates every user and warehouse membership before reading/writing private PostgreSQL data. No private inventory data, password, or service-role key belongs in this repository. The publishable key is intentionally public.

The warehouse is stored as a JSONB document with an optimistic revision check and a row-locking PostgreSQL commit function. Every write also saves its previous state in `acl_events` for recovery and audit. The current design is suitable for this small warehouse; partition/normalize the ledger and define audit retention before scaling to high-volume use.

## Deployment

1. Run `supabase/migrations/202611200001_acl.sql` in the dedicated Supabase project.
2. Deploy `supabase/functions/acl-api` (disable legacy gateway JWT verification; the function verifies the bearer token with Supabase Auth on every call and rejects nonmembers).
3. Create the owner's Auth account and insert its user ID into `acl_members` with role `owner`. Never grant anonymous write access.
4. Set public project URL, publishable key and workspace ID in `web/cloud-config.js`. Default allowed browser origin is `https://ninhbao.github.io`.
5. Publish `web` as `/docs` on the main branch and set Pages source to main /docs.
6. Sign in, then import the existing JSON backup or original ACL Excel once into the empty warehouse. Subsequent imports are blocked to prevent duplicate history.

## Operations

Orders deduct stock immediately. Dispatch creates a linked shipment without a second deduction. All edits/deletes recalculate FIFO and reject newly introduced historical shortages. Changing a product base unit relabels its history without changing quantities. Backup exports the complete warehouse snapshot, independent of the current date filter.

Do not overwrite local `data/inventory.sqlite3` with cloud exports; local and cloud copies do not sync automatically. Use the online app as the shared source after migration.

Run `node test-engine.mjs` for cloud domain checks. The Excel parser is checked against all 1,005 original movement rows. SheetJS 0.20.3 loads from its official CDN with a pinned SHA-384 integrity hash; no workbook content is sent to that CDN.
