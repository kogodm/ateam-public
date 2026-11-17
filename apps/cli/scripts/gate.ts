/**
 * M2.6 gate (machinery): exercises the flywheel against the REAL `claude -p`.
 * Synthesizes an Experience from a (synthetic) Claude Code transcript, then
 * proves recall surfaces it for a follow-up task. Human "看得见变专业"
 * judgment is the separate 2-task dogfood (see report).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore } from '@ateam/knowledge';
import { ClaudeSynthesizer, Flywheel, claudeProjectDir } from '@ateam/core';

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'ateam-gate-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ateam-gate-proj-'));
  const sid = '11111111-2222-3333-4444-555555555555';

  // a realistic Claude Code transcript: a wxpay V3 signature debugging session
  const proj = claudeProjectDir(cwd);
  mkdirSync(proj, { recursive: true });
  const lines = [
    { type: 'user', message: { role: 'user', content: '帮我接入微信支付 V3，下单接口一直签名失败 401' } },
    { type: 'assistant', message: { role: 'assistant', content: '先检查参与签名的字段。你的 nonce_str 放在哪里？' } },
    { type: 'user', message: { role: 'user', content: 'nonce_str 我放在 query string 里' } },
    { type: 'assistant', message: { role: 'assistant', content: '问题在这。WeChat Pay V3 的 nonce_str 必须在请求体 JSON 内，且签名串顺序为 method\\nurl\\ntimestamp\\nnonce_str\\nbody。把 nonce_str 移入 body 后重试。' } },
    { type: 'user', message: { role: 'user', content: '改完后下单成功了，调了快 3 小时' } },
    { type: 'assistant', message: { role: 'assistant', content: '记住：V3 签名 401 几乎都是参与签名字段不齐全或位置错误，优先核对 nonce_str/timestamp/body 是否进入签名串。' } },
  ];
  writeFileSync(join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));

  const store = new AssetStore(home);
  const fw = new Flywheel(store, new ClaudeSynthesizer());

  console.log('① reflect (real claude -p, may take ~10-40s)…');
  const t0 = Date.now();
  const exp = await fw.reflect({
    cwd,
    claudeSessionId: sid,
    agentKey: 'coder',
    scope: 'project',
    projectId: 'peizhen',
    domainHint: 'wxpay',
  });
  console.log(`   took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!exp) {
    console.error('GATE FAIL: reflect produced nothing');
    process.exit(1);
  }
  console.log(`   domain=${exp.domain}  title=${JSON.stringify(exp.title)}`);
  console.log(`   lesson=${JSON.stringify(exp.lessonLearned.slice(0, 120))}`);
  console.log(`   generalization=${JSON.stringify(exp.generalization.slice(0, 120))}`);
  console.log(`   tags=${JSON.stringify(exp.tags)}  conf=${exp.confidence.value}`);

  console.log('\n⑦ recall for a NEW wxpay task on a different project…');
  const hits = fw.recall('coder', '新项目要接微信支付，怎么避免签名失败', { domain: exp.domain });
  if (hits.length === 0 || hits[0].exp.id !== exp.id) {
    console.error('GATE FAIL: prior experience not recalled');
    process.exit(1);
  }
  console.log(`   recalled: ${JSON.stringify(hits[0].exp.title)} (score ${hits[0].score.toFixed(2)})`);

  console.log('\n④ apply it -> confidence reinforced…');
  const before = hits[0].exp.confidence.value;
  fw.markApplied(exp.id);
  const after = new AssetStore(home).listExperiences({ agentKey: 'coder' })[0];
  console.log(`   conf ${before} -> ${after?.confidence.value}  applied=${after?.appliedCount}`);

  console.log('\n⑥ growth/expertise…');
  console.log(`   ${JSON.stringify(store.growth('coder').domains)}`);

  const ok = !!exp.lessonLearned && hits[0].exp.id === exp.id && (after?.appliedCount ?? 0) === 1;
  console.log(`\nGATE MACHINERY: ${ok ? 'PASS ✓' : 'FAIL ✗'}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error('GATE ERROR', e);
  process.exit(1);
});
