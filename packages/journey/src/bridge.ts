// The door half of the combined journey: what the embedded door page reports to the story room.
// No import of the private merchant core here: the public quiet page bundles this file.
import configuration from '../../../content/combined-journey.json';
import type { Quiet, Beat } from '../../quiet-web/src/quiet';

export interface Handoff { session: string; player: string; wallet: number; day: number; slot: number }
export interface Observation { id: string; owner: string; speaker: string; text: string }
export interface Snapshot extends Handoff {
 version: 1; chapter: 'door' | 'merchant'; phase: string; ready: boolean;
 done: string[]; observations: Observation[];
}
export const CAST: Record<string,string> = configuration.cast;
export const JOURNEY = configuration;

export function lineId(text: string): string {
 let hash=2166136261;
 for (const char of text) hash=Math.imul(hash^char.charCodeAt(0),16777619);
 return (hash>>>0).toString(16);
}
/** Attribute player-first exchanges to their known NPC; prose remains narration. */
export function dialogueObservations(rows: Pick<Beat,'id'|'speaker'|'line'|'text'>[], chapter: string, initialOwner=''): Observation[] {
 let owner=initialOwner;
 const result: Observation[]=[];
 for (const row of rows) {
  if (row.speaker && row.speaker!=='player' && row.speaker!=='Narrator') owner=row.speaker;
  const text=row.line?.text ?? row.text;
  if (!text || !row.speaker || !CAST[owner]) continue;
  const speaker=row.speaker==='player' ? 'Mystery' : row.speaker==='Narrator' ? 'Narrator' : CAST[owner];
  result.push({id:lineId([chapter,owner,speaker,text].join('\n')),owner,speaker,text});
 }
 return result.slice(-80);
}
export function doorSnapshot(q: Quiet, session: string): Snapshot {
 const s=q.core.state;
 return {version:1,chapter:'door',session,player:s.player??'',day:s.day,slot:s.slot,wallet:s.wallet,
  phase:q.view().scene??'arrival',ready:!!s.scenesDone[configuration.arrivalScene] && !s.run,
  done:Object.keys(s.scenesDone).filter(id=>s.scenesDone[id]>0),
  observations:dialogueObservations(q.view().backlog,'door')};
}
export function embeddedJourney(): boolean {
 return typeof location!=='undefined' && new URLSearchParams(location.search).get('journey')==='1';
}
export function reportJourney(snapshot: Snapshot): void {
 if(embeddedJourney() && window.parent!==window) window.parent.postMessage({type:'journey:state',snapshot},location.origin);
}
