// src/gui-launcher.ts
import { createReadStream, createWriteStream, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { get } from 'node:https';
import { createUnzip } from 'node:zlib';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';

const GUI_DIR = join(homedir(), '.modelweaver', 'gui');
const VERSION_FILE = join(GUI_DIR, '.version');
const REPO = 'kianwoon/modelweaver';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function detectPlatform(): string {
  const p = platform();
  const a = arch();
  if (p === 'darwin') return a === 'arm64' ? 'darwin-aarch64' : 'darwin-x64';
  if (p === 'win32') return 'windows-x64';
  if (p === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${p} ${a}`);
}

function matchAsset(assets: Array<{ name: string; browser_download_url: string }>, platformId: string): { name: string; url: string } | null {
  const patterns: Record<string, (name: string) => boolean> = {
    'darwin-aarch64': (n) => n.endsWith('.dmg') && n.includes('aarch64'),
    'darwin-x64': (n) => n.endsWith('.dmg') && (n.includes('x64') || n.includes('x86_64')),
    'linux-x64': (n) => n.endsWith('.AppImage'),
    'windows-x64': (n) => n.endsWith('.msi'),
  };

  const matcher = patterns[platformId];
  if (!matcher) return null;

  const asset = assets.find((a) => matcher(a.name));
  return asset ? { name: asset.name, url: asset.browser_download_url } : null;
}

function getCachedVersion(): string | null {
  try {
    if (existsSync(VERSION_FILE)) {
      return readFileSync(VERSION_FILE, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return null;
}

function setCachedVersion(version: string): void {
  mkdirSync(dirname(VERSION_FILE), { recursive: true });
  writeFileSync(VERSION_FILE, version, 'utf-8');
}

function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': 'modelweaver' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, { headers: { 'User-Agent': 'modelweaver' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        get(res.headers.location, (redirectRes) => {
          if (!redirectRes.statusCode || redirectRes.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${redirectRes.statusCode}`));
            return;
          }
          redirectRes.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      // Clean up partial file on error
      try { createReadStream(dest); } catch { /* file doesn't exist */ }
      reject(err);
    });
  });
}

function launchBinary(platformId: string, assetPath: string): void {
  switch (platformId) {
    case 'darwin-aarch64':
    case 'darwin-x64':
      // macOS: mount DMG, copy .app to /Applications, launch it
      console.log('  Opening GUI...');
      execSync(`hdiutil attach "${assetPath}" -nobrowse -quiet 2>/dev/null || true`);
      // Try to find and copy the .app
      try {
        const mounts = execSync('hdiutil info | grep -A1 "image-path" | grep "/Volumes" | sed "s/.*\\(\\/Volumes.*\\)/\\1/"').toString().trim().split('\n').filter(Boolean);
        const mountPoint = mounts[mounts.length - 1];
        if (mountPoint) {
          const appPath = execSync(`ls -d "${mountPoint}/"*.app 2>/dev/null || true`).toString().trim().split('\n')[0];
          if (appPath) {
            execSync(`cp -R "${appPath}" /Applications/ 2>/dev/null || true`);
            const appName = appPath.split('/').pop()!;
            const child = spawn('open', ['-a', appName], { detached: true, stdio: 'ignore' } as any);
            child.unref();
            execSync(`hdiutil detach "${mountPoint}" -quiet 2>/dev/null || true`);
            console.log('  ModelWeaver GUI launched!');
            return;
          }
        }
      } catch {
        // Fallback: just open the DMG file
      }
      execSync(`hdiutil detach "/Volumes/ModelWeaver" -quiet 2>/dev/null || true`);
      const dmgChild = spawn('open', [assetPath], { detached: true, stdio: 'ignore' } as any);
      dmgChild.unref();
      console.log('  ModelWeaver GUI launched (DMG opened)!');
      break;

    case 'linux-x64': {
      chmodSync(assetPath, 0o755);
      const linuxChild = spawn(assetPath, [], { detached: true, stdio: 'ignore' } as any);
      linuxChild.unref();
      console.log('  ModelWeaver GUI launched!');
      break;
    }

    case 'windows-x64':
      const winChild = spawn('msiexec', ['/i', assetPath, '/passive'], { detached: true, stdio: 'ignore', shell: true } as any);
      winChild.unref();
      console.log('  ModelWeaver GUI installer launched!');
      break;
  }
}

export async function launchGui(): Promise<void> {
  console.log('\n  ModelWeaver GUI Launcher');
  console.log('  ──────────────────────\n');

  const platformId = detectPlatform();
  console.log(`  Platform: ${platformId}`);

  // Check cache
  const cachedVersion = getCachedVersion();
  if (cachedVersion) {
    console.log(`  Cached version: ${cachedVersion}`);
  }

  // Fetch latest release info
  console.log('  Checking for latest release...');
  let release: GitHubRelease;
  try {
    release = await fetchJSON(API_URL);
  } catch (err) {
    console.error(`  Failed to fetch release info: ${(err as Error).message}`);
    console.error('  Make sure you have internet access.');
    process.exit(1);
  }

  const latestVersion = release.tag_name;
  console.log(`  Latest version: ${latestVersion}`);

  // Find matching asset
  const asset = matchAsset(release.assets, platformId);
  if (!asset) {
    console.error(`  No binary found for platform: ${platformId}`);
    console.error('  Available assets:');
    for (const a of release.assets) {
      console.error(`    - ${a.name}`);
    }
    process.exit(1);
  }

  const assetPath = join(GUI_DIR, asset.name);

  // Check if we need to download
  if (cachedVersion === latestVersion && existsSync(assetPath)) {
    console.log(`  Using cached binary: ${asset.name}`);
  } else {
    console.log(`  Downloading: ${asset.name}`);
    console.log(`  Size: ~${(asset.name.length > 30 ? 'large' : 'small')} download`);

    try {
      await downloadFile(asset.url, assetPath);
      setCachedVersion(latestVersion);
      console.log('  Download complete!');
    } catch (err) {
      console.error(`  Download failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Launch the binary
  launchBinary(platformId, assetPath);
}
