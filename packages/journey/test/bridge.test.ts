import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCore, mulberry32, newGame, type Course } from '@silver-tongue/core';
import { createQuiet } from '../../quiet-web/src/quiet';
import * as bridge from '../src/bridge';

const course = JSON.parse(readFileSync(new URL('../../../dist/courses/ko-seoul/en.json', import.meta.url), 'utf8')) as Course;

function quiet() {
 const state = newGame(course);
 state.player = 'Nadia'; state.wallet = 17300; state.day = 2; state.slot = 1;
 const core = createCore(course, state, {now:()=>1000, rng:mulberry32(2)});
 return createQuiet({course, core, now:()=>1000, lab:true});
}

describe('continuous door and merchant journey: the door', () => {
 it('does not unlock the continuation before the actual Min-jun scene is complete', () => {
  expect(bridge.doorSnapshot).toBeTypeOf('function');
  const q=quiet();
  expect(bridge.doorSnapshot(q,'save-one').ready).toBe(false);
  q.core.state.scenesDone['room-minjun']=1;
  expect(bridge.doorSnapshot(q,'save-one')).toMatchObject({ready:true, player:'Nadia', wallet:17300, day:2,slot:1});
 });
 it('keeps actual choices and does not attribute one NPC’s dialogue to another', () => {
  expect(bridge.dialogueObservations).toBeTypeOf('function');
  const rows=bridge.dialogueObservations([
   {id:1,speaker:'landlady',text:'Rent is due.'},
   {id:2,speaker:'player',text:'I will tell Min-jun.'},
   {id:3,text:'A private author note that nobody heard.'},
   {id:4,speaker:'minjun',text:'I am learning English.'},
   {id:5,speaker:'player',text:'My name is Nadia.'},
  ],'door');
  expect(rows.filter(r=>r.owner==='landlady').map(r=>r.text)).toEqual(['Rent is due.','I will tell Min-jun.']);
  expect(rows.filter(r=>r.owner==='minjun').map(r=>r.text)).toEqual(['I am learning English.','My name is Nadia.']);
  expect(JSON.stringify(rows)).not.toContain('author note');
 });
});
