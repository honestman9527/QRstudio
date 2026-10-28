// Test-only dependencies can be installed outside the app; see README.md.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const jsQR = require('jsqr');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const encoderSource = readFileSync(require.resolve('qrcode-generator'), 'utf8');

function createApp({ languages = ['en-US'], savedLanguage, storageError = false } = {}) {
  const { document } = parseHTML(html);
  const storage = new Map(savedLanguage ? [['qr-language', savedLanguage]] : []);
  const timers = new Map();
  const frames = [];
  const downloads = [];
  const blobs = new Map();
  const clipboard = [];
  const alerts = [];
  const drawing = new WeakMap();
  let timerId = 0;
  let scrolls = 0;

  // LinkeDOM supplies the DOM without a browser. Fill in the browser APIs used
  // by this app, including select values and deterministic timers/canvas calls.
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperties(select, {
      selectedIndex: {
        get() { return Math.max(0, [...this.options].findIndex(option => option.hasAttribute('selected'))); },
        set(index) { [...this.options].forEach((option, i) => option.toggleAttribute('selected', i === index)); }
      },
      value: {
        get() { return this.options[this.selectedIndex]?.value || ''; },
        set(value) { this.selectedIndex = [...this.options].findIndex(option => option.value === value); }
      }
    });
  }
  for (const input of document.querySelectorAll('input[type=checkbox]')) {
    input.checked = input.hasAttribute('checked');
  }
  document.defaultView.HTMLElement.prototype.scrollIntoView = () => { scrolls++; };
  const createElement = document.createElement.bind(document);
  document.createElement = tag => {
    const element = createElement(tag);
    if (tag === 'a') element.click = () => downloads.push({ name: element.download, href: element.href });
    if (tag === 'canvas') attachCanvas(element);
    return element;
  };
  function attachCanvas(canvas) {
    const operations = [];
    drawing.set(canvas, operations);
    const context = {
      fillStyle: '#000',
      fillRect(x, y, width, height) { operations.push({ x, y, width, height, color: this.fillStyle }); },
      fillText(text) { operations.push({ text }); },
      getImageData(x, y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height }; }
    };
    for (const name of ['drawImage', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'arc', 'arcTo', 'roundRect', 'fill', 'clearRect', 'save', 'restore', 'translate', 'rotate']) {
      context[name] = () => {};
    }
    canvas.getContext = () => context;
    canvas.toBlob = callback => callback(new Blob(['test canvas'], { type: 'image/png' }));
  }
  document.querySelectorAll('canvas').forEach(attachCanvas);
  const encoderContext = vm.createContext({});
  vm.runInContext(encoderSource, encoderContext);
  const appWindow = { addEventListener() {}, innerWidth: 1024, innerHeight: 768, open() {} };
  const context = vm.createContext({
    window: appWindow, document,
    navigator: {
      languages, language: languages[0],
      clipboard: { writeText(value) { clipboard.push(value); return Promise.resolve(); } },
      mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } }
    },
    localStorage: {
      getItem(key) { if (storageError) throw new Error('Storage blocked'); return storage.get(key) || null; },
      setItem(key, value) { if (storageError) throw new Error('Storage blocked'); storage.set(key, value); }
    },
    qrcode: encoderContext.qrcode, jsQR, Intl, Blob, File,
    URL: class extends URL {
      static createObjectURL(blob) { const key = `blob:test-${blobs.size}`; blobs.set(key, blob); return key; }
      static revokeObjectURL(key) { blobs.delete(key); }
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { frames.push(callback); },
    alert(message) { alerts.push(message); },
    console: { log() {} }
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  return {
    context, document, storage, frames, downloads, blobs, clipboard, alerts, drawing,
    run(source) { return vm.runInContext(source, context); },
    flushTimers(maxDelay = 100) {
      for (const [id, { callback, delay }] of [...timers]) {
        if (delay <= maxDelay) { timers.delete(id); callback(); }
      }
    },
    selectType(type) {
      document.getElementById('type-pills').onclick({ target: document.querySelector(`[data-type="${type}"]`) });
    },
    get scrolls() { return scrolls; }
  };
}

function decodeMatrix(qr) {
  const cells = qr.getModuleCount();
  const scale = 6, margin = 4, width = (cells + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < cells; row++) for (let col = 0; col < cells; col++) {
    if (!qr.isDark(row, col)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const offset = (((row + margin) * scale + y) * width + (col + margin) * scale + x) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  return jsQR(rgba, width, width)?.data;
}

test('browser language preferences, Chinese variants and English fallback', () => {
  for (const [languages, expected] of [
    [['zh-CN'], 'zh-CN'], [['zh-TW'], 'zh-CN'], [['zh-Hant-HK'], 'zh-CN'],
    [['fr-FR', 'zh-SG', 'en'], 'zh-CN'], [['en-GB', 'zh-CN'], 'en'],
    [['fr-FR'], 'en'], [[], 'en']
  ]) {
    const app = createApp({ languages });
    assert.equal(app.document.documentElement.lang, expected);
    assert.equal(app.storage.get('qr-language'), undefined, 'automatic detection must not save a manual preference');
  }
});

test('saved choice wins and switching survives blocked storage', () => {
  const app = createApp({ languages: ['zh-CN'], savedLanguage: 'en' });
  assert.equal(app.document.documentElement.lang, 'en');
  app.run("setLanguage('zh-CN')");
  assert.equal(app.storage.get('qr-language'), 'zh-CN');
  assert.match(app.document.title, /二维码/);
  assert.equal(createApp({ savedLanguage: 'invalid', languages: ['zh'] }).document.documentElement.lang, 'zh-CN');
  const blocked = createApp({ languages: ['zh'], storageError: true });
  blocked.run("setLanguage('en')");
  assert.equal(blocked.document.documentElement.lang, 'en');
  assert.equal(blocked.document.getElementById('language-select').value, 'en');
});

test('all static translation markers work in both directions without replacing controls', () => {
  const app = createApp();
  const field = app.document.getElementById('in-text');
  field.value = '你好 QR Studio 😀';
  app.run("setLanguage('zh-CN')");
  assert.equal(app.document.getElementById('in-text'), field);
  assert.equal(field.value, '你好 QR Studio 😀');
  assert.equal(field.placeholder, '输入文本或消息…');
  assert.equal(app.document.getElementById('language-select').getAttribute('aria-label'), '语言');
  assert.match(app.document.querySelector('.hdr p').textContent, /标准二维码与品牌二维码/);
  for (const element of app.document.querySelectorAll('[data-i18n]')) {
    const key = element.getAttribute('data-i18n');
    assert.equal(app.run(`Object.hasOwn(ZH_CN, ${JSON.stringify(key)})`), true, key);
  }
  app.run("setLanguage('en')");
  assert.equal(field.placeholder, 'Enter any text or message…');
  assert.equal(app.document.querySelector('.hdr p').textContent, 'Standard & branded QR codes, zero bloat');
});

test('country names change while a country with a shared dialling code stays selected', () => {
  const app = createApp();
  const select = app.document.getElementById('ph-cc');
  select.selectedIndex = 2; // Canada shares +1 with the USA.
  app.run("setLanguage('zh-CN')");
  assert.equal(select.selectedIndex, 2);
  assert.match(select.options[2].textContent, /加拿大/);
  assert.equal(select.value, '+1');
  app.run("setLanguage('en')");
  assert.match(select.options[2].textContent, /Canada/);
  assert.equal(select.selectedIndex, 2);
});

test('validation and generated payload survive a language change', () => {
  const app = createApp();
  app.selectType('wifi');
  app.document.getElementById('wifi-ssid').value = '家里的 WiFi';
  app.document.getElementById('wifi-pass').value = 'short';
  app.flushTimers();
  assert.equal(app.document.getElementById('v-wifi-pass').textContent, 'Min 8 characters');
  app.run("setLanguage('zh-CN')");
  app.flushTimers();
  assert.equal(app.document.getElementById('v-wifi-pass').textContent, '至少 8 个字符');
  app.document.getElementById('wifi-pass').value = '中文密码12345';
  const payload = app.run('getStdData()');
  app.run("setLanguage('en'); generateStandard()");
  assert.equal(app.run('getStdData()'), payload);
  assert.equal(app.context.window._stdData, payload);
  assert.equal(app.document.getElementById('wifi-ssid').value, '家里的 WiFi');
  assert.equal(app.document.getElementById('std-preview-area').classList.contains('on'), true);
});

test('in-progress ChromaCode and its asynchronous error use the current language', async () => {
  const app = createApp();
  app.document.getElementById('cc-url').value = 'https://example.com/中文';
  app.run('ccLoadImg=()=>new Promise((resolve,reject)=>{window.rejectImage=reject})');
  const pending = app.run('generateChroma()');
  const button = app.document.getElementById('cc-gen-btn');
  assert.equal(button.disabled, true);
  app.run("setLanguage('zh-CN')");
  assert.match(button.textContent, /正在生成/);
  assert.equal(app.document.getElementById('cc-status').textContent, '正在加载图片…');
  assert.ok(button.querySelector('.spin'));
  app.run("window.rejectImage(localizedError('Cannot load image. Try uploading instead.'))");
  await pending;
  assert.equal(button.disabled, false);
  assert.match(app.document.getElementById('cc-status').textContent, /无法加载图片/);
  app.run("setLanguage('en')");
  assert.equal(app.document.getElementById('cc-status').textContent, 'Error: Cannot load image. Try uploading instead.');
});

test('scan results and safety details update without changing raw content or scrolling', () => {
  const app = createApp();
  app.run("showScanResult('http://192.168.1.1/中文')");
  const scrolls = app.scrolls;
  app.run("setLanguage('zh-CN')");
  assert.equal(app.document.getElementById('scan-content').textContent, 'http://192.168.1.1/中文');
  assert.match(app.document.getElementById('scan-safety').textContent, /内容可疑/);
  assert.match(app.document.getElementById('scan-safety').textContent, /IP 地址/);
  assert.equal(app.document.getElementById('scan-open-btn').textContent, '🔗 打开链接');
  assert.equal(app.scrolls, scrolls);
});

test('scan upload loading, success, failure and reset labels follow the selected language', () => {
  const app = createApp();
  app.context.jsQR = undefined;
  app.run("scanFile({type:'image/png'})");
  app.run("setLanguage('zh-CN')");
  assert.match(app.document.getElementById('scan-dp').textContent, /扫描器正在加载/);
  app.context.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,cXItcHJldmlldw=='; this.onload(); }
  };
  app.context.Image = class {
    naturalWidth = 32;
    naturalHeight = 32;
    set src(value) { this.onload(); }
  };
  app.context.jsQR = () => ({ data: '中文扫描内容' });
  app.run("scanFile({type:'image/png'})");
  const preview = app.document.querySelector('#scan-dp img').src;
  assert.match(app.document.getElementById('scan-dp').textContent, /已识别二维码/);
  app.run("setLanguage('en')");
  assert.equal(app.document.querySelector('#scan-dp img').src, preview);
  assert.match(app.document.getElementById('scan-dp').textContent, /QR code found/);
  assert.equal(app.document.getElementById('scan-content').textContent, '中文扫描内容');
  app.context.jsQR = () => null;
  app.run("scanFile({type:'image/png'}); setLanguage('zh-CN')");
  assert.match(app.document.getElementById('scan-dp').textContent, /未检测到二维码/);
  app.run('clearScan()');
  assert.match(app.document.getElementById('scan-dp').textContent, /拖入图片/);
  assert.equal(app.document.getElementById('scan-result').style.display, 'none');
});

test('uploaded logos and generation settings remain selected during language switching', () => {
  const app = createApp();
  app.context.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,bG9nbw=='; this.onload({ target: this }); }
  };
  app.context.Image = class {
    set src(value) { this.onload(); }
  };
  app.run("loadStdLogo({type:'image/png',name:'Phone logo.png'})");
  const original = app.run('stdLogoImg');
  const resolution = app.document.getElementById('std-res');
  resolution.value = '1024';
  app.document.getElementById('std-tmpl').value = 'birthday';
  app.document.getElementById('std-fg').value = '#1a365d';
  app.run("setTheme('light'); setLanguage('zh-CN')");
  assert.equal(app.run('stdLogoImg'), original);
  assert.equal(app.document.getElementById('std-logo-prompt').textContent, 'Phone logo.png');
  assert.equal(resolution.value, '1024');
  assert.equal(app.document.getElementById('std-tmpl').value, 'birthday');
  assert.equal(app.document.getElementById('std-fg').value, '#1a365d');
  assert.equal(app.document.documentElement.getAttribute('data-theme'), 'light');
  app.run('clearStdLogo()');
  assert.equal(app.document.getElementById('std-logo-prompt').textContent, '点击上传');
});

test('camera keeps its stream and animation loop when language changes', async () => {
  const app = createApp();
  await app.run('toggleCamera()');
  const video = app.document.getElementById('cam-video');
  const stream = video.srcObject;
  const frames = app.frames.length;
  app.run("setLanguage('zh-CN')");
  assert.equal(video.srcObject, stream);
  assert.equal(app.run('camRunning'), true);
  assert.equal(app.frames.length, frames);
  assert.equal(app.document.getElementById('cam-btn').textContent, '⏹ 关闭相机');
  app.run('stopCamera()');
  assert.equal(app.document.getElementById('cam-btn').textContent, '📷 打开相机');
});

test('copy feedback and delayed reset follow language changes', async () => {
  const app = createApp();
  app.run("showScanResult('中文内容'); copyScanResult()");
  await Promise.resolve();
  app.run("setLanguage('zh-CN')");
  assert.equal(app.document.querySelector('#scan-result .dl-btn').textContent, '✓ 已复制！');
  app.flushTimers(1500);
  assert.equal(app.document.querySelector('#scan-result .dl-btn').textContent, '📋 复制');
  assert.equal(app.clipboard[0], '中文内容');
  app.run("updateLinkBox('原始数据'); copyLink()");
  await Promise.resolve();
  assert.equal(app.document.querySelector('#std-link-box .copy-btn').textContent, '已复制！');
  app.run("setLanguage('en')");
  app.flushTimers(1500);
  assert.equal(app.document.querySelector('#std-link-box .copy-btn').textContent, 'Copy');
  assert.equal(app.clipboard[1], '原始数据');
});

test('DuitNow breakdown localizes while merchant edits, print size and raw EMV stay intact', () => {
  const app = createApp();
  app.selectType('duitnow');
  for (const [id, value] of Object.entries({ 'dn-gen-acquirer': '588734', 'dn-gen-qrid': 'TEST123', 'dn-gen-name': 'TEST SHOP', 'dn-gen-city': 'KUALA LUMPUR' })) {
    app.document.getElementById(id).value = value;
  }
  const raw = app.run('buildDuitNowEMV()');
  app.context.window.testRaw = raw;
  app.run('showScanResult(window.testRaw)');
  app.document.getElementById('dn-edit-name').value = '自定义商户名';
  app.document.getElementById('dn-edit-bank').value = 'My Bank';
  app.run('setDnSize(900)');
  app.run("setLanguage('zh-CN')");
  const breakdown = app.document.getElementById('duitnow-breakdown').textContent;
  assert.match(breakdown, /商户名称/);
  assert.match(breakdown, /食品杂货/);
  assert.match(breakdown, /✓ 有效/);
  assert.match(breakdown, /Maybank/);
  assert.equal(app.document.getElementById('dn-edit-name').value, '自定义商户名');
  assert.equal(app.document.getElementById('dn-edit-bank').value, 'My Bank');
  assert.equal(app.run('dnTargetW'), 900);
  assert.equal(app.context.window._dnRaw, raw);
  assert.match(app.document.getElementById('dn-dimensions').textContent, /厘米/);
  app.run("setLanguage('en')");
  assert.match(app.document.getElementById('duitnow-breakdown').textContent, /Merchant Name/);
  assert.equal(app.context.window._dnRaw, raw);
});

test('decoded values are text even when they contain HTML or translation-looking words', () => {
  const app = createApp({ languages: ['zh'] });
  app.selectType('duitnow');
  for (const [id, value] of Object.entries({ 'dn-gen-acquirer': '588734', 'dn-gen-qrid': 'TEST', 'dn-gen-name': '<img src=x onerror=bad()>', 'dn-gen-city': 'Phone' })) {
    app.document.getElementById(id).value = value;
  }
  app.run('showScanResult(buildDuitNowEMV())');
  const target = app.document.getElementById('duitnow-breakdown');
  assert.equal(target.querySelector('img'), null);
  assert.match(target.textContent, /<img src=x onerror=bad\(\)>/);
  assert.match(target.textContent, /Phone/);
  assert.equal(app.document.getElementById('scan-safety').querySelector('img'), null);
});

test('Chinese, mixed text and emoji round trip through the actual encoder and jsQR', () => {
  const app = createApp();
  for (const payload of ['你好，世界！', 'Hello 中文 😀 𠮷', 'https://example.com/path?q=hello', 'https://example.com/中文']) {
    const qr = app.context.qrcode(0, 'M');
    qr.addData(payload); qr.make();
    assert.equal(decodeMatrix(qr), payload);
  }
});

test('Chinese WiFi, vCard and calendar payloads round trip and stay unchanged by UI language', () => {
  const app = createApp();
  for (const [type, values] of [
    ['wifi', { 'wifi-ssid': '家里的网络', 'wifi-pass': '中文密码12345' }],
    ['vcard', { 'vc-fn': '小明', 'vc-ln': '王', 'vc-org': '示例公司' }],
    ['calendar', { 'cal-title': '团队会议', 'cal-desc': '讨论项目进度', 'cal-loc': '北京', 'cal-sd': '2026-11-01' }]
  ]) {
    app.selectType(type);
    for (const [id, value] of Object.entries(values)) app.document.getElementById(id).value = value;
    const payload = app.run('getStdData()');
    const qr = app.context.qrcode(0, 'M'); qr.addData(payload); qr.make();
    assert.equal(decodeMatrix(qr), payload, type);
    app.run("setLanguage('zh-CN')");
    assert.equal(app.run('getStdData()'), payload, type);
  }
});

test('the PNG source canvas contains a decodable Chinese QR code', () => {
  const app = createApp();
  app.selectType('text');
  app.document.getElementById('in-text').value = '中文 PNG 😀';
  app.run('generateStandard(); dlStdPNG()');
  const canvas = app.document.getElementById('std-canvas');
  const margin = 40, width = canvas.width + margin * 2, height = canvas.height + margin * 2;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const operation of app.drawing.get(canvas)) {
    if (operation.color !== '#000000') continue;
    for (let dy = 0; dy < operation.height; dy++) for (let dx = 0; dx < operation.width; dx++) {
      const offset = ((operation.y + dy + margin) * width + operation.x + dx + margin) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
  }
  assert.equal(jsQR(pixels, width, height)?.data, '中文 PNG 😀');
  assert.equal(app.downloads.at(-1).name, 'qr-code.png');
});

test('ChromaCode versions encode Chinese URLs and retain the selected version', async () => {
  const app = createApp();
  const url = 'https://example.com/中文';
  app.document.getElementById('cc-url').value = url;
  app.run("ccLoadImg=async()=>({naturalWidth:64,naturalHeight:64,src:'data:image/png;base64,c291cmNl'})");
  await app.run('generateChroma()');
  assert.equal(app.document.getElementById('cc-status').textContent, '');
  assert.equal(app.run('CCS.versions.length'), 5);
  for (const qr of app.run('CCS.versions.map(version=>version.qr)')) assert.equal(decodeMatrix(qr), url);
  app.run("ccSelectVersion(1); setLanguage('zh-CN')");
  assert.equal(app.run('CCS.selectedIdx'), 1);
  assert.equal(app.document.getElementById('cc-url').value, url);
  assert.equal(app.document.getElementById('cc-preview-area').classList.contains('on'), true);
});

test('SVG export uses the same UTF-8 data as the preview', async () => {
  const app = createApp();
  app.selectType('text');
  app.document.getElementById('in-text').value = '中文 SVG 😀';
  app.run('generateStandard(); dlStdSVG()');
  const download = app.downloads.at(-1);
  assert.equal(download.name, 'qr-code.svg');
  const svg = await app.blobs.get(download.href).text();
  const { document } = parseHTML(svg);
  const width = Number(document.querySelector('svg').getAttribute('width'));
  const margin = 40, size = width + margin * 2;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const rect of document.querySelectorAll('rect[fill="#000000"]')) {
    const x = Number(rect.getAttribute('x')), y = Number(rect.getAttribute('y'));
    const w = Number(rect.getAttribute('width')), h = Number(rect.getAttribute('height'));
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
      const offset = ((y + dy + margin) * size + x + dx + margin) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
    }
  }
  assert.equal(jsQR(pixels, size, size)?.data, '中文 SVG 😀');
});
