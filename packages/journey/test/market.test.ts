import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MarketContent } from '@silver-tongue/core/market';

// Where vitest.config.ts finds the compiled private core it aliases `@silver-tongue/core/market` to.
const MERCHANT_MARKET = join(process.env.MERCHANT_CORE_DIST || fileURLToPath(new URL('../../../../st-merchant-core/dist', import.meta.url)), 'market.js');

const content = JSON.parse(readFileSync(new URL('../../../content/experiments/merchant-town/ko.json', import.meta.url), 'utf8')) as MarketContent;
let bridge: typeof import('../src/market');

// The ordinary public checkout does not contain the private experimental core.
describe.skipIf(!existsSync(MERCHANT_MARKET))('continuous door and merchant journey: the town, against the compiled private core', () => {
beforeAll(async () => { bridge = await import('../src/market'); });

describe('continuing into town', () => {
 it('continues after Min-jun without repeating the opening or resetting the wallet', () => {
  expect(bridge.createContinuedMarket).toBeTypeOf('function');
  const handoff={session:'save-one',player:'Nadia',wallet:17300,day:2,slot:1};
  const game=bridge.createContinuedMarket(content,handoff);
  expect(game.state).toMatchObject({player:'Nadia',wallet:17300,day:2,slot:1,phase:'story'});
  expect(content.story[game.state.storyIndex].id).toBe('welcome');
  expect(game.state.preparations).toEqual([]);
 });
 it('keeps a resumed draft and pending offer instead of applying the handoff again', () => {
  expect(bridge.createContinuedMarket).toBeTypeOf('function');
  const h={session:'save-one',player:'Nadia',wallet:17300,day:2,slot:1};
  const g=bridge.createContinuedMarket(content,h);
  for(let i=0;i<30 && ['story','reaction'].includes(g.state.phase);i++){
   const s=content.story[g.state.storyIndex];
   g.send(g.state.phase==='story' && s.choices?.length ? {type:'choose',id:s.choices[0].id} : {type:'continue'});
  }
  g.send({type:'prepare',id:'stock'});g.send({type:'prepare',id:'cart'});g.send({type:'talk'});
  g.send({type:'text',text:'오늘 오천 원에 할 수 있어요.'});g.send({type:'draft',text:'아니요.'});
  expect(g.state.pending?.price).toBe(5000);
  const resumed=bridge.createContinuedMarket(content,h,g.state);
  expect(resumed.state).toEqual(g.state);
  resumed.send({type:'confirm'});resumed.send({type:'fulfill'});
  expect(resumed.state.wallet).toBe(30300 + 100000);
 });
});

describe('ending visibility',()=>{
 it('does not attribute old merchant messages to Min-jun during the ending',()=>{
  expect(bridge.marketSnapshot).toBeTypeOf('function');
  const game=bridge.createContinuedMarket(content,{session:'s',player:'Nadia',wallet:20000,day:2,slot:1});
  const state={...game.state,phase:'ending' as const,messages:[{speaker:'npc' as const,text:'Your delivery is accepted.'}]};
  expect(bridge.marketSnapshot(content,state,'s').observations).toEqual([]);
 });
});

describe('source story visibility',()=>{
 it('does not give the next NPC a previous conversation that is no longer displayed',()=>{
  const game=bridge.createContinuedMarket(content,{session:'s',player:'Nadia',wallet:20000,day:2,slot:1});
  const first=content.story[game.state.storyIndex];
  game.send({type:'choose',id:first.choices![0].id});
  const prior=game.state.messages.map(m=>m.text);
  game.send({type:'continue'});
  expect(content.story[game.state.storyIndex].npc).not.toBe(first.npc);
  const rows=bridge.marketSnapshot(content,game.state,'s').observations;
  expect(rows.length).toBeGreaterThan(0);
  for(const text of prior) expect(rows.map(r=>r.text)).not.toContain(text);
 });
});

describe('a completed agreement',()=>{
 it('tells only the merchant about the delivery and actual payment, including before the ending is read',()=>{
  const game=bridge.createContinuedMarket(content,{session:'s',player:'Nadia',wallet:20000,day:2,slot:1});
  for(let i=0;i<30&&['story','reaction'].includes(game.state.phase);i++){
   const step=content.story[game.state.storyIndex];
   game.send(game.state.phase==='story'&&step.choices?.length?{type:'choose',id:step.choices[0].id}:{type:'continue'});
  }
  game.send({type:'prepare',id:'stock'});game.send({type:'prepare',id:'cart'});game.send({type:'talk'});
  game.send({type:'text',text:'오늘 오천 원에 할 수 있어요.'});game.send({type:'confirm'});game.send({type:'fulfill'});
  const records=bridge.marketSnapshot(content,game.state,'s').observations;
  const receipt=records.find(r=>r.speaker==='Narrator'&&r.owner==='merchant');
  expect(receipt?.text).toContain('5000');
  expect(records.filter(r=>r.owner!=='merchant').some(r=>r.text.includes('5000'))).toBe(false);
 });
});


describe('merchant choice continuity',()=>{
 it('keeps a player-first reaction as a choice personally heard by the current NPC',()=>{
  const game=bridge.createContinuedMarket(content,{session:'s',player:'Nadia',wallet:20000,day:2,slot:1});
  const step=content.story[game.state.storyIndex];
  const choice=step.choices![0];
  game.send({type:'choose',id:choice.id});
  expect(game.state.messages[0]).toMatchObject({speaker:'player',text:choice.text});
  const rows=bridge.marketSnapshot(content,game.state,'s').observations;
  expect(rows).toContainEqual(expect.objectContaining({owner:'oldman',speaker:'Mystery',text:choice.text}));
  expect(rows.every(r=>r.owner==='oldman')).toBe(true);
 });
 it('keeps a prose reaction as narration rather than a fabricated NPC quotation',()=>{
  const game=bridge.createContinuedMarket(content,{session:'s',player:'Nadia',wallet:20000,day:2,slot:1});
  const choice=content.story[game.state.storyIndex].choices![0];
  expect(typeof choice.reaction).toBe('string');
  game.send({type:'choose',id:choice.id});
  const rows=bridge.marketSnapshot(content,game.state,'s').observations;
  expect(rows).toContainEqual(expect.objectContaining({owner:'oldman',speaker:'Narrator',text:choice.reaction}));
  expect(rows.some(r=>r.speaker==='Grandpa Park'&&r.text===choice.reaction)).toBe(false);
 });
});
});
