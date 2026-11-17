-- The 'dynamic' (rotating) proxy kind was removed; existing rows become 'static' (data only, no schema change).
UPDATE "proxies" SET "kind" = 'static' WHERE "kind" = 'dynamic';
