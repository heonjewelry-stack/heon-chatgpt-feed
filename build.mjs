#!/usr/bin/env node
// Heon Jewelry → ChatGPT Business ürün akışı.
// Shopify'daki aktif ve sitede yayında olan bütün ürünleri okur, OpenAI ürün akışı
// biçiminde (https://developers.openai.com/commerce/specs/file-upload/products)
// docs/feed.csv dosyasına yazar. Shopify'a hiçbir şey yazmaz (yalnızca okur).
//
// Silinen / taslağa çekilen ürünler: OpenAI listeden düşen ürünü 14 gün tutuyor.
// Bu yüzden düşen satırlar 15 gün boyunca is_eligible_search=false ile akışta kalır,
// sonra tamamen silinir (state/removed.json).
//
// Kullanım: node build.mjs [--env <.env yolu>]   (GitHub Actions'ta anahtarlar env'den gelir)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(ROOT, 'docs', 'feed.csv');
const STATE = path.join(ROOT, 'state', 'removed.json');
const LOG = path.join(ROOT, 'state', 'last-run.json');

const envArg = process.argv.indexOf('--env');
const envFile = envArg > 0 ? process.argv[envArg + 1] : path.join(os.homedir(), '.heon', '.env');
if (!process.env.SHOPIFY_CLIENT_SECRET && fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
if (!SHOPIFY_SHOP || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error('SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET eksik.');
  process.exit(1);
}
const API = `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/${process.env.SHOPIFY_API_VERSION || '2026-07'}/graphql.json`;

// Mağazaya özgü sabitler
const SITE = 'https://heonjewelry.com';
const BRAND = 'Heon Jewelry';
const RETURN_DAYS = 30; // İade politikası: teslimattan itibaren 30 gün, ücretsiz iade
const RETURN_POLICY_URL = `${SITE}/policies/refund-policy`;
const REMOVED_KEEP_DAYS = 15;

let token;
async function getToken() {
  const r = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`Shopify token alınamadı: HTTP ${r.status}`);
  token = (await r.json()).access_token;
}

async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json().catch(() => ({}));
    const throttled = j.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if ((r.status >= 500 || r.status === 429 || throttled) && attempt < 6) {
      await new Promise((res) => setTimeout(res, 2000 * attempt));
      continue;
    }
    if (!r.ok || j.errors) throw new Error(`Shopify hata: HTTP ${r.status} ${JSON.stringify(j.errors || j).slice(0, 500)}`);
    return j.data;
  }
}

const Q = `query($after:String){
  products(first:15, after:$after, query:"status:active"){
    pageInfo{ hasNextPage endCursor }
    nodes{
      id handle title descriptionHtml vendor onlineStoreUrl
      category{ fullName }
      options{ name }
      featuredMedia{ ... on MediaImage{ image{ url } } }
      media(first:12){ nodes{ ... on MediaImage{ image{ url } } } }
      gender: metafield(namespace:"mm-google-shopping", key:"gender"){ value }
      ageGroup: metafield(namespace:"mm-google-shopping", key:"age_group"){ value }
      material: metafield(namespace:"mm-google-shopping", key:"material"){ value }
      ratingCount: metafield(namespace:"heon", key:"rating_count"){ value }
      ratingAvg: metafield(namespace:"heon", key:"rating_avg"){ value }
      variants(first:250){
        nodes{ id title price compareAtPrice availableForSale barcode selectedOptions{ name value } image{ url } }
      }
    }
  }
}`;

const num = (gid) => gid.split('/').pop();
const jpg = (u) => {
  if (!u) return '';
  const url = new URL(u);
  url.searchParams.set('format', 'jpg');
  url.searchParams.set('width', '2048');
  return url.toString();
};
const money = (v) => `${Number(v).toFixed(2)} USD`;
const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
function plain(html) {
  const t = decode(
    (html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return t.length > 5000 ? t.slice(0, 4997).replace(/\s+\S*$/, '') + '…' : t;
}
const validGtin = (g) => {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(g || '')) return false;
  const d = g.split('').map(Number); const check = d.pop();
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
};

const COLS = [
  'item_id', 'group_id', 'listing_has_variations', 'variant_dict', 'title', 'description', 'url', 'brand', 'seller_name',
  'seller_url', 'image_url', 'additional_image_urls', 'availability', 'price', 'sale_price', 'condition', 'product_category',
  'material', 'color', 'size', 'gender', 'age_group', 'gtin', 'review_count', 'star_rating', 'shipping_price',
  'accepts_returns', 'return_deadline_in_days', 'return_policy', 'is_eligible_search',
];

function rowsFor(p) {
  const variants = p.variants.nodes;
  const realOptions = !(variants.length === 1 && variants[0].selectedOptions.every((o) => o.name === 'Title'));
  const images = p.media.nodes.map((m) => m.image?.url).filter(Boolean);
  const featured = p.featuredMedia?.image?.url || images[0];
  const desc = plain(p.descriptionHtml) || p.title;
  const gender = ['female', 'male', 'unisex'].includes(p.gender?.value) ? p.gender.value : '';
  const rc = parseInt(p.ratingCount?.value || '', 10);
  const ra = parseFloat(p.ratingAvg?.value || '');
  return variants.map((v) => {
    const opts = realOptions ? v.selectedOptions.filter((o) => o.name !== 'Title') : [];
    const optText = opts.map((o) => o.value).join(', ');
    let title = optText ? `${p.title} — ${optText}` : p.title;
    if (title.length > 150) title = title.slice(0, 149).replace(/\s+\S*$/, '') + '…';
    const color = opts.find((o) => /^colou?r$/i.test(o.name))?.value || '';
    const size = opts.find((o) => /size/i.test(o.name))?.value || '';
    const main = v.image?.url || featured;
    const extra = images.filter((u) => u !== main).slice(0, 10).map(jpg).map((u) => u.replace(/,/g, '%2C'));
    const price = Number(v.price);
    const cmp = Number(v.compareAtPrice || 0);
    const onSale = cmp > price && price > 0;
    return {
      item_id: num(v.id),
      group_id: realOptions ? `P${num(p.id)}` : '',
      listing_has_variations: realOptions ? 'true' : '',
      variant_dict: realOptions ? JSON.stringify(Object.fromEntries(opts.map((o) => [o.name, o.value]))) : '',
      title,
      description: desc,
      url: `${p.onlineStoreUrl}?variant=${num(v.id)}`,
      brand: BRAND,
      seller_name: BRAND,
      seller_url: SITE,
      image_url: jpg(main),
      additional_image_urls: extra.join(','),
      availability: v.availableForSale ? 'in_stock' : 'out_of_stock',
      price: money(onSale ? cmp : price),
      sale_price: onSale ? money(price) : '',
      condition: 'new',
      product_category: p.category?.fullName || '',
      material: p.material?.value || '14K gold',
      color,
      size,
      gender,
      age_group: p.ageGroup?.value === 'adult' ? 'adult' : '',
      gtin: validGtin(v.barcode) ? v.barcode : '',
      review_count: rc > 0 && ra > 0 ? String(rc) : '',
      star_rating: rc > 0 && ra > 0 ? ra.toFixed(2) : '',
      shipping_price: '0.00 USD', // Ücretsiz sigortalı kargo (ABD'ye, Illinois deposundan)
      accepts_returns: 'true',
      return_deadline_in_days: String(RETURN_DAYS),
      return_policy: RETURN_POLICY_URL,
      is_eligible_search: 'true',
    };
  });
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---- çalıştır
await getToken();
const products = [];
let after = null;
do {
  const d = await gql(Q, { after });
  products.push(...d.products.nodes);
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

const live = products.filter((p) => p.onlineStoreUrl); // yalnızca sitede yayında olanlar
const rows = live.flatMap(rowsFor);
const problems = rows.filter((r) => !r.image_url || !r.title || !r.description || !(Number(r.price.split(' ')[0]) > 0));
if (rows.length === 0) throw new Error('Hiç ürün satırı çıkmadı — akış güncellenmedi (eski dosya korunuyor).');

// Düşen ürünler: önceki akışta olup şimdi olmayanlar 15 gün "aranamaz" olarak kalır
const today = new Date().toISOString().slice(0, 10);
const removed = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const liveIds = new Set(rows.map((r) => r.item_id));
const previous = fs.existsSync(OUT) ? parseCsv(fs.readFileSync(OUT, 'utf8')) : [];
for (const r of previous) {
  if (!liveIds.has(r.item_id) && !removed[r.item_id]) removed[r.item_id] = { since: today, row: { ...r, is_eligible_search: 'false', availability: 'out_of_stock' } };
}
for (const [id, info] of Object.entries(removed)) {
  const age = (Date.parse(today) - Date.parse(info.since)) / 864e5;
  if (liveIds.has(id) || age > REMOVED_KEEP_DAYS) delete removed[id];
}
const allRows = [...rows, ...Object.values(removed).map((x) => x.row)];

const csv = [COLS.join(','), ...allRows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(OUT, csv);
fs.writeFileSync(STATE, JSON.stringify(removed, null, 1) + '\n');
fs.writeFileSync(LOG, JSON.stringify({ products: live.length, rows: rows.length, removed_kept: Object.keys(removed).length, problems: problems.map((r) => r.item_id) }, null, 1) + '\n');
console.log(`Ürün: ${live.length} | satır (varyant): ${rows.length} | düşen (15 gün tutulan): ${Object.keys(removed).length} | sorunlu: ${problems.length}`);
if (problems.length) console.log('Sorunlu satırlar:', problems.slice(0, 20).map((r) => r.item_id).join(', '));
