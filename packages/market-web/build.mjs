import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
// Only the compiled private core enters the public browser artifact.
const core = process.env.MERCHANT_CORE_DIST || resolve(repo, '../st-merchant-core/dist');
const entry = join(core, 'market.js');
if (!existsSync(entry)) throw new Error('Build the private merchant core first, or set MERCHANT_CORE_DIST to its compiled dist directory.');
const result = await build({
  entryPoints: [join(here, 'src/main.tsx')], bundle: true, write: false, format: 'esm', target: 'es2022', minify: true,
  jsx: 'automatic', jsxImportSource: 'preact', alias: { '@silver-tongue/core/market': entry }, legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(here, 'src/market.css'), 'utf8');
const page = readFileSync(join(here, 'src/index.html'), 'utf8').replace('/*CSS*/', () => css).replace('/*JS*/', () => js);
mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/index.html'), page);
const contentDir = join(repo, 'content/experiments/merchant-town');
const content = JSON.parse(readFileSync(join(contentDir, 'ko.json'), 'utf8'));
if (existsSync(join(contentDir, 'audio.json'))) {
  content.audio = JSON.parse(readFileSync(join(contentDir, 'audio.json'), 'utf8'));
  cpSync(join(contentDir, 'audio'), join(here, 'dist/audio'), { recursive: true });
}
writeFileSync(join(here, 'dist/content.json'), JSON.stringify(content));
console.log('Built isolated merchant experiment; private core source is not included.');
