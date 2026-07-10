-- Demo catalog for local Orderloop dev. Seeds the `default` tenant (anonymous
-- dev traffic resolves to `default`). Apply with:
--   pnpm exec wrangler d1 execute orchestrator --local --file=scripts/seed-products.sql
-- Re-runnable: ON CONFLICT updates in place.

INSERT INTO products (tenant_id, id, title, description, price_cents, currency, image_url, category, inventory, active, attrs_json, created_at) VALUES
  ('default', 'tee-classic',  'Classic Cotton Tee',   'Soft 100% cotton crew-neck tee.',            2500, 'usd', '', 'apparel',     50, 1, '{"sizes":["S","M","L","XL"]}', 1718000000000),
  ('default', 'hoodie-zip',   'Zip-Up Hoodie',        'Midweight fleece zip hoodie.',               5800, 'usd', '', 'apparel',     30, 1, '{"sizes":["S","M","L","XL"]}', 1718000000000),
  ('default', 'mug-12oz',     '12oz Ceramic Mug',     'Dishwasher-safe ceramic mug.',               1200, 'usd', '', 'home',        80, 1, '{}', 1718000000000),
  ('default', 'bottle-steel', 'Insulated Water Bottle','Keeps drinks cold 24h.',                    2900, 'usd', '', 'home',        40, 1, '{"capacity_oz":24}', 1718000000000),
  ('default', 'cap-6panel',   'Six-Panel Cap',        'Adjustable cotton-twill cap.',               2200, 'usd', '', 'accessories', 60, 1, '{}', 1718000000000),
  ('default', 'socks-3pk',    'Crew Socks (3-pack)',  'Cushioned cotton-blend crew socks.',         1500, 'usd', '', 'apparel',    100, 1, '{}', 1718000000000),
  ('default', 'tote-canvas',  'Canvas Tote Bag',      'Heavyweight canvas tote.',                   1800, 'usd', '', 'accessories', 70, 1, '{}', 1718000000000),
  ('default', 'sticker-pack', 'Sticker Pack',         'Set of 5 vinyl stickers.',                    600, 'usd', '', 'accessories',200, 1, '{}', 1718000000000)
ON CONFLICT (tenant_id, id) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  price_cents = excluded.price_cents,
  category = excluded.category,
  inventory = excluded.inventory,
  active = excluded.active,
  attrs_json = excluded.attrs_json;
