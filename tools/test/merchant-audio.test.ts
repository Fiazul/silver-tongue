import { expect, it } from 'vitest';
import { merchantClips } from '../src/merchant-audio';

it('includes actual price/quantity lines and avoids sending player names to speech synthesis', () => {
  const c = { voice: 'test', scenarios: [{ cost: 1000, budget: 5000, rivalPrice: 4500, quantity: 2 }],
    lines: [{ text: 'Today {price}, {quantity} items.', meaning: 'A quote' }, { text: '{player}, hello.', meaning: 'A personal greeting' }] };
  const clips = merchantClips(c);
  expect(clips.some(x => x.text === 'Today 4500, 2 items.')).toBe(true);
  expect(clips.some(x => x.text.includes('player'))).toBe(false);
  expect(new Set(clips.map(x => x.file)).size).toBe(clips.length);
});
