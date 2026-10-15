// Renders scripts/og/og.html to public/og.png (1200 x 630) with a locally
// installed Chrome or Edge in headless mode. Nothing is downloaded.
//   npm run og
// Set CHROME=/path/to/browser to use a specific browser.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = pathToFileURL(resolve(root, 'scripts/og/og.html')).href;
const out = resolve(root, 'public/og.png');

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome or Edge found. Set CHROME=/path/to/browser.');
  process.exit(1);
}
execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--force-device-scale-factor=1', '--window-size=1200,630', '--virtual-time-budget=3000', `--screenshot=${out}`, page], { stdio: 'inherit' });
console.log(`Wrote ${out} (${Math.round(statSync(out).size / 1024)} KB) with ${browser}`);
