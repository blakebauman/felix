/**
 * robots.txt builder (pure). The key AEO lever: explicitly *welcome* the AI
 * answer-engine crawlers (so a brand's catalog can be cited in generative
 * responses) and advertise the sitemap. When a brand opts out of structured
 * data we emit a Disallow for those same agents instead.
 */

/** User-agents of the major generative / answer-engine crawlers. */
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Amazonbot',
] as const;

export function robotsTxt(opts: { allowAiCrawlers: boolean; sitemapUrl?: string }): string {
  const rule = opts.allowAiCrawlers ? 'Allow: /' : 'Disallow: /';
  const lines: string[] = [];
  for (const ua of AI_CRAWLERS) {
    lines.push(`User-agent: ${ua}`, rule, '');
  }
  // Conventional crawlers are always allowed.
  lines.push('User-agent: *', 'Allow: /', '');
  if (opts.sitemapUrl) lines.push(`Sitemap: ${opts.sitemapUrl}`);
  return `${lines.join('\n').trimEnd()}\n`;
}
