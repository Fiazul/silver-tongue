import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimClip } from './audio';

interface AudioContent { voice: string; scenarios: { cost: number; budget: number; rivalPrice: number; quantity: number }[] }
/** Enumerate fixed and parameterized target-language lines, never player-personalized text. */
export function merchantClips(content: AudioContent): { text: string; file: string }[] {
  const texts = new Set<string>();
  const prices = new Set(content.scenarios.flatMap(s => [s.cost, s.budget, s.rivalPrice, 3000, 4000, 5000]));
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, unknown>;
    if (typeof row.text === 'string' && typeof row.meaning === 'string' && !row.text.includes('{player}')) {
      for (const price of prices) for (const quantity of [1, 2]) {
        const text = row.text.replaceAll('{price}', String(price)).replaceAll('{quantity}', String(quantity));
        if (/[\p{L}\p{N}]/u.test(text) && !text.includes('{')) texts.add(text);
      }
    }
    Object.values(row).forEach(visit);
  }
  visit(content);
  return [...texts].map(text => ({ text, file: `${createHash('sha256').update(`${content.voice}:${text}`).digest('hex').slice(0, 16)}.mp3` }));
}

async function main() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../content/experiments/merchant-town');
  const c = JSON.parse(readFileSync(join(dir, 'ko.json'), 'utf8')) as AudioContent;
  const clips = merchantClips(c);
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const missing = clips.filter(clip => !existsSync(join(dir, 'audio', clip.file)));
  // Small concurrent batches keep synthesis practical without flooding the service.
  const { spawn } = await import('node:child_process');
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(clip => new Promise<void>((done, fail) => {
      const file = join(dir, 'audio', clip.file);
      const child = spawn('edge-tts', ['--voice', c.voice, `--text=${clip.text}`, '--write-media', `${file}.part`], { stdio: 'ignore' });
      child.on('error', fail);
      child.on('exit', code => {
        if (code !== 0 || !trimClip(`${file}.part`)) return fail(new Error(`Audio failed: ${clip.text}`));
        renameSync(`${file}.part`, file); done();
      });
    })));
    console.log(`Audio ${Math.min(i + 4, missing.length)}/${missing.length}`);
  }
  writeFileSync(join(dir, 'audio.json'), JSON.stringify(Object.fromEntries(clips.map(c => [c.text, c.file])), null, 2) + '\n');
  console.log(`${clips.length} spoken lines ready.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exitCode = 1; });
