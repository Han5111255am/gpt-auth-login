const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===== 读取 session.json =====
const sessionPath = process.argv[2] || './session.json';
if (!fs.existsSync(sessionPath)) {
  console.error(`文件不存在: ${sessionPath}`);
  process.exit(1);
}
const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
const sessionToken = sessionData.sessionToken;
if (!sessionToken) {
  console.error('session.json 中未找到 sessionToken');
  process.exit(1);
}
console.log(`用户: ${sessionData.user?.name || '未知'}`);
console.log(`邮箱: ${sessionData.user?.email || '未知'}`);
console.log(`过期时间: ${sessionData.expires || '未知'}`);

// ===== 参数 =====
const mode = process.argv[3] || 'chrome';
const profileId = process.argv[4];
const adsPowerApiPort = process.argv[5] || '50325';
const bitApiPort = process.argv[5] || '54345';

// ===== 工具：将 cookie 写入 Chromium SQLite 数据库 =====
function writeCookieToDb(dbPath, token) {
  if (!fs.existsSync(dbPath)) {
    console.error('Cookies 数据库不存在:', dbPath);
    return false;
  }
  const db = new Database(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(cookies)').all().map(c => c.name);

    // 先删掉旧的同名 cookie
    db.prepare("DELETE FROM cookies WHERE name LIKE '__Secure-next-auth.session-token%' AND host_key LIKE '%chatgpt%'").run();

    const now = Math.floor(Date.now() / 1000);
    const winEpoch = 11644473600;
    const nowMicro = (now + winEpoch) * 1000000;
    const expiresMicro = (now + 365 * 24 * 3600 + winEpoch) * 1000000;

    // 如果 token 超过 4000 字符，分片存储（匹配 Chrome 的大 cookie 行为）
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

    console.log(`  cookie 已写入 (${chunks.length} 个分片)`);
    return true;
  } finally {
    db.close();
  }
}

// ===== 工具：在 AdsPower cache 中查找 profile 目录 =====
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

// ===== AdsPower API =====
async function startAdsPower() {
  const apiUrl = `http://127.0.0.1:${adsPowerApiPort}/api/v1/browser/start?user_id=${profileId}`;
  console.log(`正在通过 AdsPower API 启动 profile: ${profileId}...`);
  const resp = await fetch(apiUrl);
  const json = await resp.json();
  if (json.code !== 0) {
    console.error('AdsPower 返回错误:', json.msg);
    process.exit(1);
  }
  return json.data.ws.puppeteer;
}

async function stopAdsPower() {
  const apiUrl = `http://127.0.0.1:${adsPowerApiPort}/api/v1/browser/stop?user_id=${profileId}`;
  try { await fetch(apiUrl); } catch (_) {}

  // 等待 SunBrowser 进程完全退出
  console.log('等待浏览器进程退出...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const out = execSync(
        'powershell -Command "if (Get-Process SunBrowser -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"',
        { timeout: 5000, stdio: 'pipe' }
      );
      if (out.status === 0 || out.toString().trim() === '') {
        console.log('  浏览器已完全退出');
        return;
      }
    } catch (_) {}
    process.stdout.write('.');
  }
  console.log('\n  警告：浏览器可能未完全退出，继续尝试...');
}

// ===== 工具：在 Bit Browser cache 中查找 profile 目录 =====
function findBitBrowserCacheDir(profileId) {
  const base = path.join(process.env.APPDATA || '', 'BitBrowser', 'BrowserCache');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base);
  const match = dirs.find(d => d === profileId);
  if (match) return path.join(base, match);
  return null;
}

// ===== Bit 浏览器 API =====
async function startBitBrowser() {
  const apiUrl = `http://127.0.0.1:${bitApiPort}/browser/start?profileId=${profileId}`;
  console.log(`正在通过 Bit 浏览器 API 启动 profile: ${profileId}...`);
  const resp = await fetch(apiUrl);
  const json = await resp.json();
  if (!json.success) { console.error('Bit 浏览器返回错误:', json.msg); process.exit(1); }
  return json.data.ws;
}

// ===== 主流程 =====
(async () => {
  let browser;

  // ---- chrome 模式：持久化 context + SQLite + 系统浏览器 ----
  if (mode === 'chrome') {
    const userDataDir = path.resolve('./tmp-gpt-profile');
    if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });

    // 选浏览器通道
    let channel = null;
    for (const ch of ['chrome', 'msedge']) {
      try {
        console.log(`尝试启动 ${ch}...`);
        const testBrowser = await chromium.launch({ headless: false, channel: ch });
        await testBrowser.close();
        channel = ch;
        break;
      } catch (_) {}
    }
    console.log(`使用浏览器: ${channel || 'chromium'}`);

    // 首次启动创建 profile
    console.log('初始化 profile...');
    let ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(channel ? { channel } : {}),
    });
    const initPage = ctx.pages()[0] || (await ctx.newPage());
    await initPage.goto('about:blank');
    await ctx.close();

    // 写入 cookie 到 SQLite
    const dbPath = path.join(userDataDir, 'Default', 'Network', 'Cookies');
    writeCookieToDb(dbPath, sessionToken);

    // 二次启动（cookie 已预加载）
    console.log('启动浏览器（已加载 session）...');
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(channel ? { channel } : {}),
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    console.log('打开 ChatGPT...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });

    console.log('\n✅ session 注入完成！请确认登录状态。');
    console.log('   操作完成后，回到终端按 Enter 关闭浏览器。');
    console.log('按 Enter 关闭浏览器...');
    process.stdin.once('data', async () => { await ctx.close(); console.log('已关闭'); process.exit(0); });

    return;
  }

  // ---- adspower 模式：查找 profile DB → 写 cookie → 启动浏览器 ----
  if (mode === 'adspower') {
    if (!profileId) { console.error('请提供 AdsPower profile ID'); process.exit(1); }

    // 先停止（确保 DB 文件可写入）
    console.log('确保浏览器已关闭...');
    await stopAdsPower();
    await new Promise(r => setTimeout(r, 2000));

    // 查找 cache 目录
    const cacheDir = findAdsPowerCacheDir(profileId);
    if (!cacheDir) {
      console.error('未找到 AdsPower profile 缓存目录');
      console.error('请手动指定路径: node inject-session.js session.json adspower <profile_id> <api_port> <cache_path>');
      process.exit(1);
    }
    console.log('Profile 目录:', cacheDir);

    // 写入 cookie
    const dbPath = path.join(cacheDir, 'Default', 'Network', 'Cookies');
    if (!writeCookieToDb(dbPath, sessionToken)) process.exit(1);

    // 启动浏览器
    const wsEndpoint = await startAdsPower();
    console.log('已连接 WebSocket');
    browser = await chromium.connectOverCDP(wsEndpoint);
    const context = browser.contexts()[0];
    const page = await context.newPage();

    console.log('打开 ChatGPT...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });

    console.log('\n✅ session 注入完成！请确认登录状态。');
    console.log('   操作完成后，回到终端按 Enter 关闭浏览器。');
    console.log('按 Enter 关闭浏览器...');
    process.stdin.once('data', async () => { await browser.close(); console.log('已关闭'); process.exit(0); });

    return;
  }

  // ---- bit 模式 ----
  if (mode === 'bit') {
    if (!profileId) { console.error('请提供 Bit 浏览器 profile ID'); process.exit(1); }

    // 查找 cache 目录
    const cacheDir = findBitBrowserCacheDir(profileId);
    if (!cacheDir) {
      console.error('未找到 Bit Browser profile 缓存目录');
      console.error('请确保已手动打开过该 profile（至少一次），以生成缓存文件');
      process.exit(1);
    }
    console.log('Profile 目录:', cacheDir);

    // 写入 cookie
    const dbPath = path.join(cacheDir, 'Default', 'Network', 'Cookies');
    if (!writeCookieToDb(dbPath, sessionToken)) process.exit(1);

    // 尝试通过 API 启动浏览器
    console.log('尝试通过 API 启动浏览器...');
    try {
      const wsEndpoint = await startBitBrowser();
      browser = await chromium.connectOverCDP(wsEndpoint);
      const context = browser.contexts()[0];
      const page = await context.newPage();
      console.log('打开 ChatGPT...');
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch (e) {
      console.log('API 启动失败:', e.message);
      console.log('请手动从 Bit Browser 控制台打开 profile: ' + profileId);
    }

    console.log('\n✅ session 注入完成！请确认登录状态。');
    console.log('   操作完成后，回到终端按 Enter 关闭浏览器。');
    console.log('按 Enter 关闭浏览器...');
    process.stdin.once('data', async () => {
      if (browser) { await browser.close(); }
      console.log('已关闭'); process.exit(0);
    });
    return;
  }

  console.error('未知模式: ' + mode + '，可用: chrome / adspower / bit');
  process.exit(1);
})();
