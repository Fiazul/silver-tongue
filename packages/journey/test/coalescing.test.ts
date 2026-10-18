import {describe,expect,it} from 'vitest';
import {mergeSnapshots} from '../../../experiments/story-room/web/journey-state.js';

describe('room sync while gameplay continues',()=>{
 it('keeps both NPCs witnessed lines while saving the latest chapter state',()=>{
  const first={session:'one',wallet:20000,phase:'reaction',observations:[{id:'first',owner:'oldman',speaker:'Mystery',text:'Hello.'}]};
  const next={session:'one',wallet:30000,phase:'story',observations:[{id:'second',owner:'jiwoo',speaker:'Ji-woo',text:'Would you like food?'}]};
  const combined=mergeSnapshots(first,next);
  expect(combined.wallet).toBe(30000);
  expect(combined.observations.map(r=>r.id)).toEqual(['first','second']);
  expect(mergeSnapshots(combined,next).observations).toHaveLength(2);
 });
 it('does not copy observations into another saved game',()=>{
  const old={session:'one',observations:[{id:'secret',owner:'minjun',speaker:'Mystery',text:'A private introduction.'}]};
  const fresh={session:'two',observations:[]};
  expect(mergeSnapshots(old,fresh)).toEqual(fresh);
 });
});
