// The merchant half of the combined journey. It needs the private merchant core
// (`@silver-tongue/core/market`), which only the experiment build supplies.
import { createMarketGame, restoreMarketState, type MarketContent, type MarketState } from '@silver-tongue/core/market';
import { JOURNEY, dialogueObservations, lineId, type DialogueRow, type Handoff, type Snapshot } from './bridge';

const MERCHANT_IDS: Record<string,string> = JOURNEY.merchantActors;

/** Apply the transition only to a new merchant save. Existing drafts/terms are restored as-is. */
export function createContinuedMarket(c: MarketContent, h: Handoff, saved?: unknown) {
 if (saved && restoreMarketState(c,saved)) return createMarketGame(c,saved);
 const game=createMarketGame(c);
 game.send({type:'name',text:h.player});
 const first=c.story.findIndex(step=>step.id===JOURNEY.marketStart);
 if(first<0) throw new Error('The town welcome is missing from the story.');
 const continued: MarketState={...game.state,player:h.player,phase:'story',storyIndex:first,wallet:h.wallet,
  day:h.day,slot:h.slot,visitDay:Math.max(7,Math.ceil(h.day/7)*7)};
 if(!restoreMarketState(c,continued)) throw new Error('The arrival save cannot continue into town.');
 return createMarketGame(c,continued);
}
export function marketSnapshot(c: MarketContent, s: Readonly<MarketState>, session: string): Snapshot {
 const stage=c.story[s.storyIndex];
 const owner=['merchant','town'].includes(s.phase) ? 'merchant' : ['story','reaction'].includes(s.phase) ? MERCHANT_IDS[stage.npc??'']??'' : '';
 const rows: DialogueRow[]=[];
 // Source lines become witnessed when displayed, never by importing future story beats.
 if(s.phase==='story' && typeof stage.text!=='string' && owner) rows.push({id:0,speaker:owner,text:stage.text.text.replaceAll('{player}',s.player)});
 if(owner && s.phase!=='story') rows.push(...s.messages.map((m,i)=>{
  const prose=s.phase==='reaction' && stage.choices?.some(choice=>typeof choice.reaction==='string' && choice.reaction.replaceAll('{player}',s.player)===m.text);
  // A choice's prose reaction is narration whichever speaker the core gives it ('npc' in older merchant cores, 'world' in newer ones).
  return {id:i+1,speaker:prose?'Narrator':m.speaker==='npc'?owner:m.speaker==='player'?'player':undefined,text:m.text};
 }));
 const observations=dialogueObservations(rows,'merchant',owner);
 for(const deal of s.deals.filter(d=>d.fulfilled)) {
  const item=c.scenarios.find(sc=>sc.id===deal.scenario)?.item??deal.scenario;
  const text=`The player fulfilled your ${item} agreement (quantity ${deal.quantity}); you paid the agreed ${deal.price}.`;
  observations.push({id:lineId('receipt:'+deal.scenario+':'+deal.price),owner:JOURNEY.traderId,speaker:'Narrator',text});
 }
 return {version:1,chapter:'merchant',session,player:s.player,day:s.day,slot:s.slot,wallet:s.wallet,
  phase:s.phase,ready:false,done:s.deals.filter(d=>d.fulfilled).map(d=>d.scenario),observations:observations.slice(-80)};
}
