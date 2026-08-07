/**
 * Memory-quality benchmark runner.
 *
 * Replays the fixture conversations through the real extraction prompt, judges
 * the resulting memory, prints a table, and exits non-zero when any axis falls
 * below its floor — so this can gate a prompt change rather than merely
 * describe one.
 *
 * It calls models directly over the Anthropic API rather than through
 * `env.AI`, because there is no Workers runtime here. That means the scores
 * are not identical to what the Workers-AI extraction model produces in
 * production; what the benchmark measures is the PROMPT, which is the part
 * that actually regresses. Run it before and after a prompt edit and compare.
 *
 * The default model is the one `claude-sonnet-4` resolves to in
 * `DEFAULT_MODEL_ROUTES` — the script talks to the API directly, so it has to
 * name a real upstream model rather than a Felix route alias. Overriding it
 * with a newer model is possible but not free: models after the 4.6 generation
 * reject `temperature`, and a gating benchmark wants a deterministic sample.
 *
 *   ANTHROPIC_API_KEY=... pnpm bench:memory
 *   MEMORY_BENCH_MODEL=claude-sonnet-4-6 pnpm bench:memory
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  averageScores,
  type BenchConversation,
  type BenchResult,
  DEFAULT_FLOORS,
  failedAxes,
  formatReport,
  JUDGE_PROMPT,
  parseConversation,
  parseJudgeVerdict,
  replayConversation,
} from '@felix/harness/memory/bench';
import { EXTRACTION_PROMPT, parseFacts, renderExchange } from '@felix/harness/memory/capture';
import type { ChatMessage } from '@felix/harness/patterns/types';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MEMORY_BENCH_MODEL ?? 'claude-sonnet-4-6';
const MAX_FACTS = Number(process.env.MEMORY_BENCH_MAX_FACTS ?? 5);
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/harness/tests/fixtures/memory-bench',
);

async function complete(system: string, user: string, maxTokens: number): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const body = (await resp.json()) as { content?: Array<{ text?: string }> };
  return body.content?.map((c) => c.text ?? '').join('') ?? '';
}

function loadFixtures(): BenchConversation[] {
  const out: BenchConversation[] = [];
  for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))) {
    const parsed = parseConversation(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')));
    if (!parsed) throw new Error(`fixture ${file} is malformed`);
    out.push(parsed);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The production extraction path, with the model call swapped for the API. */
async function captureViaApi(messages: ChatMessage[]): Promise<string[]> {
  const exchange = renderExchange(messages, 6_000);
  if (!exchange) return [];
  return parseFacts(await complete(EXTRACTION_PROMPT, exchange, 400), MAX_FACTS);
}

async function judge(conversation: BenchConversation, facts: string[]) {
  const transcript = conversation.turns
    .map((t) => `user: ${t.input}\nassistant: ${t.reply}`)
    .join('\n');
  const stored = facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(memory is empty)';
  const verdict = parseJudgeVerdict(
    await complete(JUDGE_PROMPT, `Conversation:\n${transcript}\n\nStored memory:\n${stored}`, 400),
  );
  if (!verdict) throw new Error(`judge returned an unparseable verdict for ${conversation.id}`);
  return verdict;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('ANTHROPIC_API_KEY is required to run the memory benchmark.');
    process.exit(2);
  }

  const conversations = loadFixtures();
  const results: BenchResult[] = [];
  for (const conversation of conversations) {
    process.stderr.write(`· ${conversation.id}\n`);
    // Replay turn by turn, exactly as capture runs in production — the
    // staleness axis is meaningless if the whole conversation is scored at once.
    const facts = await replayConversation(conversation, captureViaApi);
    results.push({
      conversation: conversation.id,
      facts,
      scores: await judge(conversation, facts),
    });
  }

  console.log('');
  console.log(formatReport(results));
  console.log('');
  for (const r of results) {
    if (r.scores.notes) console.log(`${r.conversation}: ${r.scores.notes}`);
  }
  if (process.env.MEMORY_BENCH_VERBOSE) {
    for (const r of results) {
      console.log(`\n--- ${r.conversation} (${r.facts.length} facts)`);
      for (const f of r.facts) console.log(`  - ${f}`);
    }
  }

  const failed = failedAxes(averageScores(results), DEFAULT_FLOORS);
  if (failed.length > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
