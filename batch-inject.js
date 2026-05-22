const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== 参数 =====
const configPath = process.argv[2] || './profiles.json';
const batchMode = process.argv[3] || 'sequential'; // sequential | parallel

if (!fs.existsSync(configPath)) {
  console.error(`配置文件不存在: ${configPath}`);
  console.error('用法: node batch-inject.js <profiles.json> [sequential|parallel]');
  process.exit(1);
}

const profiles = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (!Array.isArray(profiles) || profiles.length === 0) {
  console.error('配置文件格式错误，应为数组');
  process.exit(1);
}

console.log(`加载了 ${profiles.length} 个 profile`);
console.log(`模式: ${batchMode === 'parallel' ? '并行（全部同时打开）' : '串行（逐个处理）'}\n`);

// ===== 工具函数（复用 inject-session.js 的逻辑）=====

function writeCookieToDb(dbPath, token) {
  if (!fs.existsSync(dbPath)) {
    console.error('  Cookies 数据库不存在:', dbPath);
    return false;
  }
  const db = new Database(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(cookies)').all().map(c => c.name);

    db.prepare("DELETE FROM cookies WHERE name LIKE '__Secure-next-auth.session-token%' AND host_key LIKE '%chatgpt%'").run();

    const now = Math.floor(Date.now() / 1000);
    const winEpoch = 11644473600;
    const nowMicro = (now + winEpoch) * 1000000;
    const expiresMicro = (now + 365 * 24 * 3600 + winEpoch) * 1000000;

    const chunkSize = 4000;
    const chunks = [];
    for (let i = 0; i < token.length; i += chunkSize) {
      chunks.push(token.substring(i, i + chunkSize));
    }
    const isChunked = chunks.length > 1;

    for (let i = 0; i < chunks.length; i++) {
      const name = '__Secure-next-auth.session-token' + (isChunked ? '.' + i : '');
      const values = {
        creation_utc: nowMicro - 1000000,
        host_key: '.chatgpt.com',
        top_frame_site_key: '',
        name: name,
        value: chunks[i],
        encrypted_value: '',
        path: '/',
        expires_utc: expiresMicro,
        is_secure: 1,
        is_httponly: 1,
        last_access_utc: nowMicro,
        has_expires: 1,
        is_persistent: 1,
        priority: 1,
        samesite: 2,
        source_scheme: 2,
        source_port: -1,
        last_update_utc: nowMicro,
        source_type: 0,
        has_cross_site_ancestor: 0,
        is_edgelegacycookie: 0,
        browser_provenance: 0,
      };
      const presentKeys = cols.filter(k => values.hasOwnProperty(k));
      const placeholders = presentKeys.map(() => '?').join(', ');
      const sql = `INSERT OR REPLACE INTO cookies (${presentKeys.join(', ')}) VALUES (${placeholders})`;
      db.prepare(sql).run(...presentKeys.map(k => values[k]));
    }
    return true;
  } finally {
    db.close();
  }
}

function findAdsPowerCacheDir(userId) {
  const possiblePaths = [
    path.join(process.env.APPDATA || '', 'adspower_global', 'cache'),
    'D:\\.ADSPOWER_GLOBAL\\cache',
    'C:\\.ADSPOWER_GLOBAL\\cache',
  ];
  for (const cacheDir of possiblePaths) {
    if (!fs.existsSync(cacheDir)) continue;
    const dirs = fs.readdirSync(cacheDir);
    const match = dirs.find(d => d.startsWith(userId + '_'));
    if (match) return path.join(cacheDir, match);
  }
  return null;
}

function findBitBrowserCacheDir(profileId) {
  const base = path.join(process.env.APPDATA || '', 'BitBrowser', 'BrowserCache');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base);
  const match = dirs.find(d => d === profileId);
  if (match) return path.join(base, match);
  return null;
}

async function stopAdsPower(profileId, port = '50325') {
  const apiUrl = `http://127.0.0.1:${port}/api/v1/browser/stop?user_id=${profileId}`;
  try { await fetch(apiUrl); } catch (_) {}
  // 等待 SunBrowser 退出
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      execSync(
        'powershell -Command "if (Get-Process SunBrowser -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"',
        { timeout: 5000, stdio: 'pipe' }
      );
      return;
    } catch (_) {}
  }
}

async function startAdsPower(profileId, port = '50325') {
  const resp = await fetch(`http://127.0.0.1:${port}/api/v1/browser/start?user_id=${profileId}`);
  const json = await resp.json();
  if (json.code !== 0) throw new Error(`AdsPower 错误: ${json.msg}`);
  return json.data.ws.puppeteer;
}

async function startBitBrowser(profileId, port = '54345') {
  const resp = await fetch(`http://127.0.0.1:${port}/browser/start?profileId=${profileId}`);
  const json = await resp.json();
  if (!json.success) throw new Error(`Bit 错误: ${json.msg}`);
  return json.data.ws;
}

// ===== 注入单个 profile =====
function injectOne(entry) {
  const { name, session: sessionFile, mode, profileId } = entry;

  if (!fs.existsSync(sessionFile)) {
    console.error(`  [${name}] session 文件不存在: ${sessionFile}`);
    return false;
  }

  const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  const token = sessionData.sessionToken;
  if (!token) {
    console.error(`  [${name}] session 文件中未找到 sessionToken`);
    return false;
  }

  let cacheDir;
  if (mode === 'adspower') {
    cacheDir = findAdsPowerCacheDir(profileId);
  } else if (mode === 'bit') {
    cacheDir = findBitBrowserCacheDir(profileId);
  } else {
    console.error(`  [${name}] 不支持的模式: ${mode}`);
    return false;
  }

  if (!cacheDir) {
    console.error(`  [${name}] 未找到 profile 缓存目录 (profileId: ${profileId})`);
    return false;
  }

  const dbPath = path.join(cacheDir, 'Default', 'Network', 'Cookies');
  console.log(`  [${name}] 写入 cookie → ${cacheDir}`);
  return writeCookieToDb(dbPath, token);
}

// ===== 打开单个 profile =====
async function openOne(entry) {
  const { name, mode, profileId } = entry;
  console.log(`  [${name}] 启动浏览器...`);
  try {
    let wsEndpoint;
    if (mode === 'adspower') {
      wsEndpoint = await startAdsPower(profileId);
    } else if (mode === 'bit') {
      wsEndpoint = await startBitBrowser(profileId);
    }
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
    console.log(`  [${name}] 打开 ChatGPT...`);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    console.log(`  [${name}] ✅ 已就绪`);
    return browser;
  } catch (e) {
    console.error(`  [${name}] ❌ 启动失败: ${e.message}`);
    return null;
  }
}

// ===== 主流程 =====
(async () => {
  // 验证所有条目
  for (const entry of profiles) {
    if (!entry.name || !entry.session || !entry.mode || !entry.profileId) {
      console.error('配置条目缺少必填字段 (name/session/mode/profileId):', entry);
      process.exit(1);
    }
  }

  if (batchMode === 'parallel') {
    // ========== 并行模式 ==========
    console.log('===== 阶段 1/2: 批量关闭浏览器并注入 cookie =====\n');

    for (const entry of profiles) {
      console.log(`[${entry.name}]`);
      if (entry.mode === 'adspower') {
        console.log(`  关闭浏览器...`);
        await stopAdsPower(entry.profileId);
        await new Promise(r => setTimeout(r, 2000));
      }
      if (injectOne(entry)) {
        console.log(`  ✅ cookie 注入成功`);
      } else {
        console.log(`  ❌ cookie 注入失败`);
      }
      console.log('');
    }

    console.log('===== 阶段 2/2: 批量启动所有浏览器 =====\n');

    const browsers = [];
    for (const entry of profiles) {
      const browser = await openOne(entry);
      if (browser) browsers.push({ name: entry.name, browser });
      console.log('');
    }

    console.log(`✅ 全部完成！已打开 ${browsers.length}/${profiles.length} 个浏览器窗口`);
    console.log('   完成所有操作后，回到终端按 Enter 关闭所有窗口。');
    console.log('按 Enter 关闭所有浏览器...');
    process.stdin.once('data', async () => {
      for (const { name, browser } of browsers) {
        console.log(`  关闭 [${name}]...`);
        try { await browser.close(); } catch (_) {}
      }
      console.log('已全部关闭');
      process.exit(0);
    });

  } else {
    // ========== 串行模式（默认）==========
    for (let i = 0; i < profiles.length; i++) {
      const entry = profiles[i];
      console.log(`===== [${i + 1}/${profiles.length}] ${entry.name} =====`);

      // 关闭 + 注入
      if (entry.mode === 'adspower') {
        console.log('关闭已有浏览器...');
        await stopAdsPower(entry.profileId);
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!injectOne(entry)) {
        console.log(`❌ 跳过 ${entry.name}（注入失败）\n`);
        continue;
      }

      // 打开浏览器
      const browser = await openOne(entry);
      if (!browser) {
        console.log(`❌ 跳过 ${entry.name}（启动失败）\n`);
        continue;
      }

      console.log(`\n✅ [${entry.name}] 已就绪，请完成操作。`);
      if (i < profiles.length - 1) {
        console.log(`   完成后按 Enter 关闭此窗口，继续下一个 (${profiles[i + 1].name})...`);
      } else {
        console.log('   完成后按 Enter 关闭窗口，结束。');
      }

      await new Promise(resolve => {
        process.stdin.once('data', async () => {
          console.log(`  关闭 [${entry.name}]...`);
          try { await browser.close(); } catch (_) {}
          console.log('');
          resolve();
        });
      });
    }

    console.log('✅ 全部完成！');
    process.exit(0);
  }
})();
