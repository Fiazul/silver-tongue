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
   {id:1,speaker:'landlady',text:'Rent is due.',scene:'room-rent'},
   {id:2,speaker:'player',text:'I will pay tomorrow.',scene:'room-rent'},
   {id:3,text:'A private author note that nobody heard.'},
   {id:4,speaker:'minjun',text:'I am learning English.',scene:'room-minjun'},
   {id:5,speaker:'player',text:'My name is Nadia.',scene:'room-minjun'},
  ],'door');
  expect(rows.filter(r=>r.owner==='landlady').map(r=>r.text)).toEqual(['Rent is due.','I will pay tomorrow.']);
  expect(rows.filter(r=>r.owner==='minjun').map(r=>r.text)).toEqual(['I am learning English.','My name is Nadia.']);
  expect(JSON.stringify(rows)).not.toContain('author note');
 });
 it('credits a scene that opens with the player to that scene’s NPC, never the previous one', () => {
  const sceneNpc=(scene: string)=>course.scenes.find(s=>s.id===scene)?.npc ?? '';
  const backlog=[
   {id:1,speaker:'landlady',text:'Rent is due.',scene:'room-rent'},
   {id:2,speaker:'player',text:'I will pay tomorrow.',scene:'room-rent'},
   {id:3,text:'The landlady goes downstairs.'},
   {id:4,speaker:'player',text:'Hello? Is anyone here?',scene:'room-minjun'},
   {id:5,speaker:'minjun',text:'Who are you?',scene:'room-minjun'},
  ];
  const rows=bridge.dialogueObservations(backlog,'door','',sceneNpc);
  expect(rows.map(r=>[r.owner,r.speaker,r.text])).toEqual([
   ['landlady','The Landlady','Rent is due.'],
   ['landlady','Mystery','I will pay tomorrow.'],
   ['minjun','Mystery','Hello? Is anyone here?'],
   ['minjun','Kim Min-jun','Who are you?'],
  ]);
  // Without a way to name the new scene's NPC, the opening line is withheld rather than misattributed.
  const unknown=bridge.dialogueObservations(backlog,'door');
  expect(unknown.find(r=>r.text==='Hello? Is anyone here?')).toBeUndefined();
  expect(unknown.filter(r=>r.owner==='landlady').map(r=>r.text)).toEqual(['Rent is due.','I will pay tomorrow.']);
 });
});
