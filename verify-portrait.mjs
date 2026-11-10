import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { OpenAICompatibleModel } from './dist/src/infrastructure/models/openai-compatible.js';
import { PORTRAIT_PROMPT, renderPersonCard } from './dist/src/memory/person.js';
const raw = JSON.parse(readFileSync('./test/fixtures/memories.json','utf8'));
const env = Object.fromEntries(readFileSync('./.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const model = new OpenAICompatibleModel({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL });
// 找记忆最多的那个人
const counts = new Map();
for (const r of raw) if (r.user_id) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
const [topId, topCount] = [...counts].sort((a,b)=>b[1]-a[1])[0];
const facts = raw.filter(r => r.user_id === topId);
const names = JSON.parse(readFileSync('./test/fixtures/aliases.json','utf8'))[topId] ?? [];
console.log(`这个人 ${topId}：${topCount} 条记忆，称呼 ${JSON.stringify(names)}\n`);
const Schema = z.object({ portrait: z.string().max(200), notes: z.array(z.string().max(120)).max(8), evidence: z.array(z.string()).max(20) });
const out = await model.decide({ role: 'dream', schema: Schema, instructions: PORTRAIT_PROMPT,
  context: { names, facts: facts.map(r => ({ id: String(r.id), fact: String(r.content).slice(0, 100) })) } });
console.log(renderPersonCard({ userId: topId, names: names.length ? names : [topId], portrait: out.portrait,
  notes: out.notes, portraitEvidence: out.evidence, firstSeenAt: 0, lastSeenAt: 0, groups: [] }));
