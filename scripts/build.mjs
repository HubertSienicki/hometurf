// Copies just the files the game needs (page, code, sound assets) into dist/,
// stamps the build (git commit, time) into js/version.js, and writes:
//   dist/version.json  - polled by running games to offer "new version, reload"
//   CHANGELOG.md       - rendered from the changelog in js/version.js
//   npm run build
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const { VERSION, CHANGELOG } = await import(pathToFileURL(path.join(root, 'js', 'version.js')).href);

const git = cmd => { try { return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const commit = (git('rev-parse --short HEAD') || 'nogit') + (git('status --porcelain') ? '-dirty' : '');
const date = new Date().toISOString();
const build = { version: VERSION, commit, date };

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of ['index.html', 'style.css', 'favicon.svg']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.cpSync(path.join(root, 'js'), path.join(out, 'js'), { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });

const vf = path.join(out, 'js', 'version.js');
const src = fs.readFileSync(vf, 'utf8');
const stamped = src.replace(/export const BUILD = \{[^}]*\};/, `export const BUILD = ${JSON.stringify({ commit, date })};`);
if (stamped === src) throw new Error('js/version.js: BUILD line not found');
fs.writeFileSync(vf, stamped);
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify(build, null, 2) + '\n');

const md = ['# Changelog', '', 'Generated from `js/version.js` by `npm run build`.', ''];
for (const e of CHANGELOG) md.push(`## ${e.v} - ${e.title} (${e.date})`, '', ...e.items.map(i => `- ${i}`), '');
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), md.join('\n'));

const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (pkg.version !== VERSION) { pkg.version = VERSION; fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n'); }

let n = 0;
const count = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? count(path.join(d, e.name)) : n++; };
count(out);
console.log(`dist/ ready: ${n} files, v${VERSION} (${commit})`);
if (commit.endsWith('-dirty')) console.log('note: uncommitted changes - commit before deploying so the build matches a git version');
