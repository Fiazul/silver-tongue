import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MarketContent } from '@silver-tongue/core/market';

// The compiled private core, found as vitest.config.ts and build.mjs find it: MERCHANT_CORE_DIST or a sibling checkout.
const coreUrl = pathToFileURL(join(process.env.MERCHANT_CORE_DIST || fileURLToPath(new URL('../../../../st-merchant-core/dist', import.meta.url)), 'market.js'));
const content = JSON.parse(readFileSync(new URL('../../../content/experiments/merchant-town/ko.json', import.meta.url), 'utf8')) as MarketContent;
let create: typeof import('@silver-tongue/core/market').createMarketGame;

// The ordinary public checkout does not contain the private experimental core.
describe.skipIf(!existsSync(coreUrl))('authored merchant experiment against its compiled private core', () => {
  beforeAll(async () => { create = (await import(coreUrl.href)).createMarketGame; });
  const prepared = (resources = ['stock', 'cart']) => {
    const g = create(content); g.send({ type: 'name', text: 'QA' });
    for (let i = 0; i < 30 && ['story', 'reaction'].includes(g.state.phase); i++) {
      const step = content.story[g.state.storyIndex];
      if (g.state.phase === 'story' && step.choices?.length) g.send({ type: 'choose', id: step.choices[0].id });
      else g.send({ type: 'continue' });
    }
    for (const id of resources) g.send({ type: 'prepare', id });
    g.send({ type: 'talk' }); return g;
  };
  it('uses questions as communication and completes the whole authored town', () => {
    const g = prepared();
    g.send({ type: 'text', text: '뭐가 필요해요?' });
    expect(g.state.messages.at(-1)?.meaning).toBe('I need two chairs. Please bring them today.');
    g.send({ type: 'text', text: '오늘 오천 원에 할 수 있어요.' });
    expect(g.state.pending).toMatchObject({ price: 5000, quantity: 2 });
    g.send({ type: 'confirm' }); g.send({ type: 'fulfill' });
    for (let i = 0; i < 3; i++) g.send({ type: 'continue' });
    expect(g.state.phase).toBe('complete');
    expect(g.state.wallet).toBe(33000 + 100000);
    expect(g.state.payout?.bonus).toBe(100000);
  });
  it('says feedback to the player in their own voice, never as the merchant', () => {
    const g = prepared(); g.send({ type: 'text', text: '오늘 하지 않을게요.' });
    expect(g.state.messages.at(-1)?.speaker).toBe('self');
    expect(g.state.messages.at(-1)?.text).toMatch(/^[\x00-\x7F’]+$/);
  });
  it('help never offers a ready-made answer: no hints, no composer insertion', () => {
    expect(content.scenarios.every(s => s.hints.length === 0)).toBe(true);
    const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/type: 'draft', text: (phrase|text)/);
  });
  it.each(['오늘 오천 원에 하지 않을게요.', '오늘 5000원에 의자 1개 할게요.', '오늘 5000원에 의자 3개 할게요.', '오늘 -5000원에 할게요.', '오늘 5000.5원에 할게요.', '오늘 5000원 또는 500원에 할게요.'])('does not reserve misinterpreted terms: %s', text => {
    const g = prepared(); g.send({ type: 'draft', text }); g.send({ type: 'text', text });
    expect(g.state.pending).toBeNull(); expect(g.state.draft).toBe(text);
    expect(g.state.wallet).toBe(30000); expect(g.state.slot).toBe(0);
  });
  it('lets the player decline a paused offer instead of trapping them in it', () => {
    const g = prepared(); g.send({ type: 'text', text: '오늘 오천 원에 할 수 있어요.' });
    g.send({ type: 'leave' }); g.send({ type: 'talk' }); g.send({ type: 'text', text: '아니요.' });
    expect(g.state.phase).toBe('town'); expect(g.state.pending).toBeNull(); expect(g.state.slot).toBe(1);
  });
  it('permits a different feasible strategy after a furniture opportunity changes', () => {
    const g = prepared(['cart', 'boxes']);
    g.send({ type: 'text', text: '뭐가 필요해요?' }); g.send({ type: 'leave' }); g.send({ type: 'talk' });
    expect(content.scenarios[g.state.scenario].id).toBe('delivery');
    g.send({ type: 'text', text: '오늘 삼천 원에 배달할 수 있어요.' });
    expect(g.state.pending?.price).toBe(3000);
  });
});
