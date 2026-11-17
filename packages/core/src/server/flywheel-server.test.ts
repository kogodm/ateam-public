import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DistilledSkill,
  GrowthReport,
  LearnedItem,
  LlmSynthesizer,
  ReflectionItem,
} from '@ateam/knowledge';
import { AssetStore } from '@ateam/knowledge';
import { createInprocPair } from '@ateam/transport';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager';
import { RpcClient } from './rpc-client';
import { createServer } from './rpc-server';

class NoSynth implements LlmSynthesizer {
  reflect(): Promise<ReflectionItem[]> {
    return Promise.resolve([]);
  }
  learnFromRepo(): Promise<LearnedItem[]> {
    return Promise.resolve([]);
  }
  distillSkill(domain: string): Promise<DistilledSkill> {
    return Promise.resolve({ name: domain, domain, description: '', body: '', tags: [] });
  }
}

class SummarizingSynth extends NoSynth {
  constructor(private readonly out: string) {
    super();
  }
  summarize(): Promise<string> {
    return Promise.resolve(this.out);
  }
}

describe('human.summarize over the contract', () => {
  /** `seedMeta: false` leaves the human with an empty meta knowledge base —
   *  summarize must then skip the LLM entirely (that emptiness is exactly
   *  what used to be handed to the model, which answered "暂无足够记录。"). */
  async function harness(synth: LlmSynthesizer, seedMeta = true) {
    const home = mkdtempSync(join(tmpdir(), 'ateam-sum-'));
    process.env.ATEAM_HOME = home;
    const sessions = new SessionManager();
    const server = createServer({ sessions, synth, storeRoot: home });
    const { client, server: sp } = createInprocPair();
    server.attach(sp);
    const rpc = new RpcClient(client);
    const created = await rpc.request<{ human: { id: string } }>('human.create', {
      name: 'sumguy',
      role: 'coder',
    });
    const id = created.human.id;
    if (seedMeta) {
      const metaDir = join(home, 'users', 'local', 'agents', id, 'meta');
      mkdirSync(join(metaDir, 'knowledge'), { recursive: true });
      writeFileSync(join(metaDir, 'meta.md'), '# index\n- **wxpay** — v3 signing notes\n');
      writeFileSync(join(metaDir, 'knowledge', 'wxpay.md'), 'nonce_str goes in the body\n');
    }
    return { rpc, server, id };
  }

  it('stores the summary when the synth returns text', async () => {
    const prev = process.env.ATEAM_HOME;
    try {
      const { rpc, server, id } = await harness(new SummarizingSynth('a sharp backend engineer'));
      const res = await rpc.request<{
        human: { experienceSummary?: { text: string; at: string } };
      }>('human.summarize', { id });
      expect(res.human.experienceSummary?.text).toBe('a sharp backend engineer');
      expect(Number.isNaN(Date.parse(res.human.experienceSummary?.at ?? ''))).toBe(false);
      server.shutdown();
    } finally {
      if (prev === undefined) delete process.env.ATEAM_HOME;
      else process.env.ATEAM_HOME = prev;
    }
  });

  it('returns the existing human unchanged when the synth fails (empty result)', async () => {
    const prev = process.env.ATEAM_HOME;
    try {
      const { rpc, server, id } = await harness(new SummarizingSynth(''));
      const res = await rpc.request<{ human: { experienceSummary?: unknown } }>('human.summarize', {
        id,
      });
      expect(res.human.experienceSummary).toBeUndefined();
      server.shutdown();
    } finally {
      if (prev === undefined) delete process.env.ATEAM_HOME;
      else process.env.ATEAM_HOME = prev;
    }
  });

  it('skips the LLM entirely when the meta knowledge base is empty', async () => {
    const prev = process.env.ATEAM_HOME;
    try {
      let called = false;
      class SpySynth extends NoSynth {
        summarize(): Promise<string> {
          called = true;
          return Promise.resolve('should never be stored');
        }
      }
      const { rpc, server, id } = await harness(new SpySynth(), false);
      const res = await rpc.request<{ human: { experienceSummary?: unknown } }>('human.summarize', {
        id,
      });
      expect(called).toBe(false);
      expect(res.human.experienceSummary).toBeUndefined();
      server.shutdown();
    } finally {
      if (prev === undefined) delete process.env.ATEAM_HOME;
      else process.env.ATEAM_HOME = prev;
    }
  });
});

describe('flywheel over the contract', () => {
  it('asset.search / agent.growth / agent.expertise reflect the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-srv-'));
    const seed = new AssetStore(root);
    for (let i = 0; i < 5; i++)
      seed.saveExperience({
        agentKey: 'coder',
        scope: 'project',
        projectId: 'p',
        domain: 'wxpay',
        title: `wxpay note ${i}`,
        narrative: 'nonce_str signature wxpay v3',
        lessonLearned: 'nonce_str in body',
        tags: ['wxpay'],
      });

    const sessions = new SessionManager();
    const server = createServer({ sessions, synth: new NoSynth(), storeRoot: root });
    const { client, server: sp } = createInprocPair();
    server.attach(sp);
    const rpc = new RpcClient(client);

    const search = await rpc.request<{ hits: { domain: string }[] }>('asset.search', {
      agentKey: 'coder',
      query: 'wxpay signature nonce',
      domain: 'wxpay',
    });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]?.domain).toBe('wxpay');

    const growth = await rpc.request<GrowthReport>('agent.growth', { agentKey: 'coder' });
    expect(growth.totalExperiences).toBe(5);
    expect(growth.domains[0]?.domain).toBe('wxpay');
    // 5 experiences but fresh single_project confidence (0.5) -> senior, not expert
    expect(growth.domains[0]?.level).toBe('senior');

    const exp = await rpc.request<{ domains: { domain: string }[] }>('agent.expertise', {
      agentKey: 'coder',
    });
    expect(exp.domains[0]?.domain).toBe('wxpay');

    server.shutdown();
  });

  it('skill.import + config.* over the contract (first-run flow)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ateam-home-'));
    const skills = mkdtempSync(join(tmpdir(), 'ateam-skd-'));
    writeFileSync(join(skills, 's.md'), '---\ndomain: wxpay\n---\n# WeChat Pay\nsteps');
    const prev = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
    try {
      const sessions = new SessionManager();
      const server = createServer({ sessions, synth: new NoSynth(), storeRoot: home });
      const { client, server: sp } = createInprocPair();
      server.attach(sp);
      const rpc = new RpcClient(client);

      const c0 = await rpc.request<{ firstRun: boolean }>('config.get');
      expect(c0.firstRun).toBe(true);

      const imp = await rpc.request<{ imported: number }>('skill.import', {
        agentKey: 'coder',
        dir: skills,
      });
      expect(imp.imported).toBe(1);

      await rpc.request('config.markRole', { role: 'coder', skillDir: skills });
      await rpc.request('config.finish');

      const c1 = await rpc.request<{
        firstRun: boolean;
        config: { roles: Record<string, { skillDir?: string }> };
      }>('config.get');
      expect(c1.firstRun).toBe(false);
      expect(c1.config.roles.coder?.skillDir).toBe(skills);

      server.shutdown();
    } finally {
      if (prev === undefined) delete process.env.ATEAM_HOME;
      else process.env.ATEAM_HOME = prev;
    }
  });
});
