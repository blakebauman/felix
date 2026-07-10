/**
 * sitemap.xml builders (pure). A sitemap lists a brand's canonical product URLs
 * so search/answer engines can enumerate the catalog without crawling the chat
 * surface. Mirrors the pure-mapper style of `jsonld.ts`.
 */

import type { Product } from '../models';

function xmlEscape(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string,
  );
}

function productUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/products/${encodeURIComponent(id)}`;
}

/** A `<urlset>` of canonical product URLs. `lastmod` derives from created_at. */
export function productsToSitemapXml(products: Product[], baseUrl: string): string {
  const urls = products.map((p) => {
    const loc = xmlEscape(productUrl(baseUrl, p.id));
    const lastmod = new Date(p.created_at).toISOString().slice(0, 10);
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** A `<sitemapindex>` pointing at one or more child sitemaps. */
export function sitemapIndexXml(sitemapUrls: string[]): string {
  const entries = sitemapUrls.map(
    (u) => `  <sitemap>\n    <loc>${xmlEscape(u)}</loc>\n  </sitemap>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`;
}
