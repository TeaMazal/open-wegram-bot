/**
 * Admin panel for installing webhooks and sending group notices.
 */

import {handleInstall, handleUninstall, postToTelegramApi} from './core.js';
import {hashPassword, loadState, pushLog, saveState, verifyPassword} from './store.js';

const COOKIE = 'ow_admin';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function safeEqual(left, right) {
    const a = new TextEncoder().encode(String(left ?? ''));
    const b = new TextEncoder().encode(String(right ?? ''));
    const len = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;
    for (let i = 0; i < len; i++) {
        diff |= (a[i] || 0) ^ (b[i] || 0);
    }
    return diff === 0;
}

function parseCookies(request) {
    const header = request.headers.get('Cookie') || '';
    const out = {};
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
}

async function sign(secret, payload) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        {name: 'HMAC', hash: 'SHA-256'},
        false,
        ['sign']
    );
    const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return [...new Uint8Array(raw)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookieSecret(config) {
    return config.adminPassword || 'panel-fallback-key';
}

async function makeCookie(config) {
    const exp = Date.now() + SESSION_MS;
    const sig = await sign(cookieSecret(config), `admin:${exp}`);
    return `${exp}.${sig}`;
}

async function hasSession(request, config) {
    const token = parseCookies(request)[COOKIE];
    if (!token || !token.includes('.')) return false;
    const index = token.indexOf('.');
    const exp = token.slice(0, index);
    const sig = token.slice(index + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(sig, await sign(cookieSecret(config), `admin:${exp}`));
}

function cookieHeader(value) {
    return [
        `${COOKIE}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
        value ? `Max-Age=${Math.floor(SESSION_MS / 1000)}` : 'Max-Age=0'
    ].join('; ');
}

function isSameOrigin(request) {
    const origin = request.headers.get('Origin');
    if (!origin) {
        return request.method === 'GET' || request.headers.get('Sec-Fetch-Site') === 'same-origin';
    }
    return origin === new URL(request.url).origin;
}

function htmlPage(title, body) {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg:#0e1218; --card:#171e28; --line:#2a3442; --text:#edf3fb; --muted:#8ea0b5; --accent:#3d8bfd; --ok:#3dd68c; --soft:#121924; }
* { box-sizing:border-box; }
body { margin:0; font-family:ui-sans-serif,system-ui,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif; background:radial-gradient(900px 420px at 0% 0%, #1a4d8a2e, transparent 60%), var(--bg); color:var(--text); }
main { width:min(1120px, calc(100% - 28px)); margin:28px auto 72px; }
h1 { font-size:26px; margin:0 0 6px; }
.sub { color:var(--muted); margin:0; line-height:1.6; }
.top { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:20px; }
.grid { display:grid; gap:14px; }
.grid-3 { grid-template-columns:1fr; }
.grid-2 { grid-template-columns:1fr; }
@media (min-width:860px) {
  .grid-3 { grid-template-columns:repeat(3, 1fr); }
  .grid-2 { grid-template-columns:1.2fr .8fr; }
  .span-2 { grid-column:span 2; }
}
.card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:18px; }
.card.hero { background:linear-gradient(180deg, #1b2736, var(--card)); }
.card h2 { margin:0 0 10px; font-size:16px; }
.card p { margin:0 0 12px; }
label { display:block; color:var(--muted); font-size:12px; margin:8px 0 6px; }
input, textarea, select { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--soft); color:var(--text); font:inherit; }
textarea { min-height:92px; resize:vertical; }
.fields { display:grid; gap:10px; }
@media (min-width:860px) { .fields-3 { grid-template-columns:160px 1fr auto; align-items:end; } .fields-2 { grid-template-columns:1fr 1fr; } }
.row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
button { appearance:none; border:0; background:var(--accent); color:white; padding:10px 14px; border-radius:10px; font-weight:600; cursor:pointer; }
button.secondary { background:#2a3644; }
button.danger { background:#7a2e2e; }
button.full { width:100%; }
.flash { padding:12px 14px; border-radius:12px; margin-bottom:14px; line-height:1.5; }
.flash.ok { background:#123524; color:var(--ok); }
.flash.bad { background:#3a1518; color:#ffd0d0; }
.flash.info { background:#132033; color:#cfe3ff; }
pre { white-space:pre-wrap; word-break:break-word; background:var(--soft); padding:12px; border-radius:10px; overflow:auto; }
.check { display:flex; gap:8px; align-items:center; color:var(--text); margin:10px 0 0; }
.check input { width:auto; }
.muted { color:var(--muted); font-size:13px; line-height:1.55; }
.list { display:grid; gap:8px; }
.item { display:flex; justify-content:space-between; gap:8px; align-items:center; background:var(--soft); border-radius:10px; padding:10px 12px; }
.pill { display:inline-block; padding:4px 8px; border-radius:999px; background:#223044; color:#cfe3ff; font-size:12px; }
.actions form { margin:0; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function flashBox(flash) {
    if (!flash) return '';
    return `<div class="flash ${flash.type}">${escapeHtml(flash.text)}</div>`;
}

function currentBot(state) {
    return (state.bots || []).find((bot) => bot.id === state.selectedBotId) || state.bots?.[0] || null;
}

function botOptions(state) {
    const selected = currentBot(state);
    return (state.bots || []).map((bot) => {
        const isSelected = selected && bot.id === selected.id;
        return `<option value="${escapeHtml(bot.id)}" ${isSelected ? 'selected' : ''}>${escapeHtml(bot.name || bot.uid || bot.id)}</option>`;
    }).join('');
}

function logList(state) {
    const logs = state.logs || [];
    if (!logs.length) {
        return '<p class="muted">还没有操作记录。</p>';
    }
    return `<div class="list">${logs.map((log) => `
      <div class="item">
        <div>
          <strong>${escapeHtml(log.action)}</strong>
          <div class="muted">${escapeHtml(log.detail || '')}</div>
        </div>
        <div class="muted">${escapeHtml(new Date(log.t).toLocaleString('zh-CN', {hour12: false}))}</div>
      </div>`).join('')}</div>`;
}

function loginPage(config, flash) {
    return htmlPage('管理登录', `
      <h1>双向机器人管理</h1>
      <p class="sub">登录后先保存机器人，再点开通、查询或发通知。Token 用普通输入框，不会被浏览器当成密码自动填充。</p>
      ${flashBox(flash)}
      <section class="card" style="max-width:420px;margin-top:18px">
        <h2>登录</h2>
        <form method="post" action="/admin/login" autocomplete="off">
          <label for="password">管理密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <div class="row"><button type="submit">登录</button></div>
        </form>
      </section>
    `);
}

function dashboard(state, flash, resultText = '') {
    const bot = currentBot(state);
    const hasBot = !!bot;
    return htmlPage('管理面板', `
      <div class="top">
        <div>
          <h1>管理面板</h1>
          <p class="sub">上面选中一个机器人，下面的按钮都对它生效。默认只转发私聊，群通知不受影响。</p>
        </div>
        <form method="post" action="/admin/logout"><button class="secondary" type="submit">退出</button></form>
      </div>
      ${flashBox(flash)}

      <section class="card hero">
        <h2>当前机器人</h2>
        ${hasBot ? `
          <p><span class="pill">${escapeHtml(bot.name || '未命名')}</span> <span class="muted">UID ${escapeHtml(bot.uid || '未填写')}</span></p>
          <form method="post" action="/admin/select" class="fields fields-3">
            <div>
              <label>切换已保存的机器人</label>
              <select name="id" onchange="this.form.submit()">${botOptions(state)}</select>
            </div>
            <div class="muted">选中后，开通、查询、卸载、发通知都用这个机器人，不用每个框再贴 Token。</div>
            <button class="secondary" type="submit">切换</button>
          </form>
          <form method="post" action="/admin/bots/delete" class="row">
            <input type="hidden" name="id" value="${escapeHtml(bot.id)}">
            <button class="danger" type="submit">删除当前保存</button>
          </form>
        ` : '<p class="muted">还没有保存机器人。先在下面填一次 UID 和 Token，保存后就不用重复填了。</p>'}

        <form method="post" action="/admin/bots/save" autocomplete="off" style="margin-top:16px">
          <h2 style="margin-top:8px">添加 / 更新机器人</h2>
          <div class="fields fields-3">
            <div>
              <label for="uid">管理员 UID</label>
              <input id="uid" name="uid" inputmode="numeric" placeholder="一串数字" value="${escapeHtml(bot?.uid || '')}" autocomplete="off">
            </div>
            <div>
              <label for="bot_token">Bot Token</label>
              <input id="bot_token" name="bot_token" type="text" placeholder="123456:ABC..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true">
            </div>
            <button type="submit">保存并选用</button>
          </div>
        </form>
      </section>

      <div class="grid grid-3" style="margin-top:14px">
        <section class="card actions">
          <h2>开通双向</h2>
          <p class="muted">给当前机器人安装 Webhook，只转发私聊。</p>
          <form method="post" action="/admin/install"><button class="full" type="submit" ${hasBot ? '' : 'disabled'}>安装 Webhook</button></form>
        </section>
        <section class="card actions">
          <h2>查看状态</h2>
          <p class="muted">看 Webhook 有没有挂上，会不会积压消息。</p>
          <form method="post" action="/admin/status"><button class="full secondary" type="submit" ${hasBot ? '' : 'disabled'}>查询</button></form>
        </section>
        <section class="card actions">
          <h2>关闭双向</h2>
          <p class="muted">卸载 Webhook。机器人还在群里，通知还能发。</p>
          <form method="post" action="/admin/uninstall"><button class="full secondary" type="submit" ${hasBot ? '' : 'disabled'}>卸载 Webhook</button></form>
        </section>
        <section class="card actions">
          <h2>测试私聊</h2>
          <p class="muted">给当前 UID 发一条测试消息。</p>
          <form method="post" action="/admin/test"><button class="full secondary" type="submit" ${hasBot ? '' : 'disabled'}>发送测试</button></form>
        </section>
        <section class="card span-2">
          <h2>发送群通知</h2>
          <form method="post" action="/admin/notify" class="fields">
            <div class="fields fields-2">
              <div>
                <label for="chatId">群 ID</label>
                <input id="chatId" name="chatId" placeholder="群一般是负数" required ${hasBot ? '' : 'disabled'}>
              </div>
              <div>
                <label for="text">内容</label>
                <textarea id="text" name="text" required ${hasBot ? '' : 'disabled'}></textarea>
              </div>
            </div>
            <div class="row"><button type="submit" ${hasBot ? '' : 'disabled'}>发送到群</button></div>
          </form>
        </section>
      </div>

      <div class="grid grid-2" style="margin-top:14px">
        <section class="card">
          <h2>转发设置</h2>
          <form method="post" action="/admin/settings">
            <label class="check">
              <input type="checkbox" name="forwardGroups" value="1" ${state.forwardGroups ? 'checked' : ''}>
              允许把群消息也转到私聊
            </label>
            <p class="muted">默认关闭。只有勾上，群里的话才会进管理员私信。</p>
            <div class="row"><button type="submit">保存设置</button></div>
          </form>
        </section>
        <section class="card">
          <h2>改登录密码</h2>
          <form method="post" action="/admin/password" autocomplete="off">
            <div class="fields fields-2">
              <div>
                <label for="currentPassword">当前密码</label>
                <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required>
              </div>
              <div>
                <label for="newPassword">新密码</label>
                <input id="newPassword" name="newPassword" type="password" minlength="6" autocomplete="new-password" required>
              </div>
            </div>
            <label for="confirmPassword">再输一次新密码</label>
            <input id="confirmPassword" name="confirmPassword" type="password" minlength="6" autocomplete="new-password" required>
            <p class="muted">只改面板密码。Cloudflare 的 ADMIN_PASSWORD 仍可应急登录。</p>
            <div class="row"><button type="submit">保存新密码</button></div>
          </form>
        </section>
      </div>

      <section class="card" style="margin-top:14px">
        <h2>操作记录</h2>
        ${logList(state)}
      </section>
      ${resultText ? `<section class="card" style="margin-top:14px"><h2>结果</h2><pre>${escapeHtml(resultText)}</pre></section>` : ''}
    `);
}

function redirect(location, headers = {}) {
    return new Response(null, {status: 303, headers: {Location: location, ...headers}});
}

async function readForm(request) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) {
        data[key] = String(value).trim();
    }
    data.token = data.token || data.bot_token || '';
    return data;
}

function maskWebhookUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split('/');
        if (parts.length >= 2) parts[parts.length - 1] = '***';
        return `${parsed.origin}${parts.join('/')}`;
    } catch (error) {
        return '(installed)';
    }
}

function summarizeTelegram(me, hook) {
    const username = me.username ? '@' + me.username : '-';
    const webhook = hook.url ? maskWebhookUrl(hook.url) : '未安装';
    return `bot: ${username} ${me.first_name || ''}\nwebhook: ${webhook}\npending: ${hook.pending_update_count ?? 0}`.trim();
}

function findBot(state, id) {
    return (state.bots || []).find((bot) => bot.id === id);
}

function resolveCreds(form, state) {
    const saved = form.botId ? findBot(state, form.botId) : currentBot(state);
    return {
        token: form.token || saved?.token || '',
        uid: form.uid || saved?.uid || '',
        saved
    };
}

async function persistBot(config, state, token, uid, enabled = true) {
    if (!config.kv || !token) {
        return config.kv ? saveState(config.kv, state) : state;
    }
    if (!enabled) {
        return saveState(config.kv, state);
    }
    let name = uid || 'bot';
    try {
        const meRes = await postToTelegramApi(token, 'getMe', {});
        const me = await meRes.json();
        if (me.ok) {
            name = me.result?.username ? `@${me.result.username}` : (me.result?.first_name || name);
        }
    } catch (error) {
        // Keep the fallback name if Telegram is unreachable.
    }
    const existing = (state.bots || []).find((bot) => bot.token === token);
    const bot = {
        id: existing?.id || crypto.randomUUID(),
        name,
        uid: uid || existing?.uid || '',
        token
    };
    const bots = [bot, ...(state.bots || []).filter((item) => item.token !== token)].slice(0, 20);
    return await saveState(config.kv, pushLog({...state, bots, selectedBotId: bot.id}, '保存机器人', name));
}

async function passwordOk(password, config, state) {
    if (state.password && await verifyPassword(password, state.password)) {
        return true;
    }
    return !!(config.adminPassword && safeEqual(password, config.adminPassword));
}

export async function handleAdmin(request, config) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const loggedIn = await hasSession(request, config);
    const state = await loadState(config.kv);

    if (path === '/admin' && request.method === 'GET') {
        return loggedIn ? dashboard(state) : loginPage(config);
    }

    if (request.method !== 'POST' || !isSameOrigin(request)) {
        return new Response('Forbidden', {status: 403});
    }

    if (path === '/admin/login') {
        const form = await readForm(request);
        if (!await passwordOk(form.password, config, state)) {
            return loginPage(config, {type: 'bad', text: '密码不对'});
        }
        return redirect('/admin', {'Set-Cookie': cookieHeader(await makeCookie(config))});
    }

    if (path === '/admin/logout') {
        return redirect('/admin', {'Set-Cookie': cookieHeader('')});
    }

    if (!loggedIn) {
        return loginPage(config, {type: 'bad', text: '请先登录'});
    }

    if (path === '/admin/select') {
        const form = await readForm(request);
        if (!findBot(state, form.id)) {
            return dashboard(state, {type: 'bad', text: '没有这个机器人'});
        }
        const next = await saveState(config.kv, {...state, selectedBotId: form.id});
        return dashboard(next, {type: 'ok', text: `已切换到 ${findBot(next, form.id)?.name || '机器人'}`});
    }

    if (path === '/admin/bots/save') {
        const form = await readForm(request);
        if (!form.token || !form.uid) {
            return dashboard(state, {type: 'bad', text: '保存机器人需要 UID 和 Token'});
        }
        const next = await persistBot(config, state, form.token, form.uid, true);
        return dashboard(next, {type: 'ok', text: '已保存并设为当前机器人'});
    }

    if (path === '/admin/password') {
        const form = await readForm(request);
        if (!await passwordOk(form.currentPassword, config, state)) {
            return dashboard(state, {type: 'bad', text: '当前密码不对'});
        }
        if (!form.newPassword || form.newPassword.length < 6) {
            return dashboard(state, {type: 'bad', text: '新密码至少 6 位'});
        }
        if (form.newPassword !== form.confirmPassword) {
            return dashboard(state, {type: 'bad', text: '两次新密码不一致'});
        }
        const password = await hashPassword(form.newPassword);
        const next = await saveState(config.kv, pushLog({...state, password}, '改密码', '已更新面板登录密码'));
        return dashboard(next, {type: 'ok', text: '面板密码已更新，下次请用新密码登录'});
    }

    if (path === '/admin/settings') {
        const form = await readForm(request);
        const next = await saveState(config.kv, pushLog({
            ...state,
            forwardGroups: form.forwardGroups === '1'
        }, '转发设置', form.forwardGroups === '1' ? '允许转发群消息' : '只转发私聊'));
        return dashboard(next, {type: 'ok', text: next.forwardGroups ? '已允许转发群消息' : '已恢复为只转发私聊'});
    }

    if (path === '/admin/bots/delete') {
        const form = await readForm(request);
        const removed = findBot(state, form.id);
        const bots = (state.bots || []).filter((bot) => bot.id !== form.id);
        const selectedBotId = state.selectedBotId === form.id ? (bots[0]?.id || '') : state.selectedBotId;
        const next = await saveState(config.kv, pushLog({...state, bots, selectedBotId}, '删除机器人', removed?.name || form.id));
        return dashboard(next, {type: 'ok', text: '已删除保存的机器人'});
    }

    if (path === '/admin/install') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.uid || !creds.token) {
            return dashboard(state, {type: 'bad', text: '请先保存一个带 UID 和 Token 的机器人'});
        }
        const response = await handleInstall(request, creds.uid, creds.token, config.prefix, config.secretToken);
        const payload = await response.json();
        const next = payload.success
            ? await persistBot(config, pushLog(state, '开通双向', creds.uid), creds.token, creds.uid, true)
            : state;
        return dashboard(next, {type: payload.success ? 'ok' : 'bad', text: payload.message || JSON.stringify(payload)}, JSON.stringify(payload, null, 2));
    }

    if (path === '/admin/uninstall') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token) {
            return dashboard(state, {type: 'bad', text: '请先选择已保存的机器人'});
        }
        const response = await handleUninstall(creds.token, config.secretToken);
        const payload = await response.json();
        const next = payload.success ? await saveState(config.kv, pushLog(state, '关闭双向', creds.saved?.name || 'bot')) : state;
        return dashboard(next, {type: payload.success ? 'ok' : 'bad', text: payload.message || JSON.stringify(payload)}, JSON.stringify(payload, null, 2));
    }

    if (path === '/admin/status') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token) {
            return dashboard(state, {type: 'bad', text: '请先选择已保存的机器人'});
        }
        const [meRes, hookRes] = await Promise.all([
            postToTelegramApi(creds.token, 'getMe', {}),
            postToTelegramApi(creds.token, 'getWebhookInfo', {})
        ]);
        const me = await meRes.json();
        const webhook = await hookRes.json();
        if (!me.ok) {
            return dashboard(state, {type: 'bad', text: me.description || 'Token 无效'}, JSON.stringify(me, null, 2));
        }
        const next = await persistBot(config, pushLog(state, '查询状态', me.result?.username ? `@${me.result.username}` : 'bot'), creds.token, creds.uid, true);
        return dashboard(next, {type: webhook.result?.url ? 'ok' : 'info', text: summarizeTelegram(me.result || {}, webhook.result || {})}, JSON.stringify({
            bot: me.result?.username ? `@${me.result.username}` : me.result?.first_name,
            webhook: maskWebhookUrl(webhook.result?.url || ''),
            pending_update_count: webhook.result?.pending_update_count ?? 0
        }, null, 2));
    }

    if (path === '/admin/notify') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token || !form.chatId || !form.text) {
            return dashboard(state, {type: 'bad', text: '请选择机器人，并填写群 ID 和内容'});
        }
        const response = await postToTelegramApi(creds.token, 'sendMessage', {chat_id: form.chatId, text: form.text});
        const payload = await response.json();
        const next = payload.ok ? await saveState(config.kv, pushLog(state, '群通知', form.chatId)) : state;
        return dashboard(next, {type: payload.ok ? 'ok' : 'bad', text: payload.ok ? '群通知已发送' : (payload.description || '发送失败')}, JSON.stringify({ok: payload.ok, chat_id: form.chatId, message_id: payload.result?.message_id}, null, 2));
    }

    if (path === '/admin/test') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token || !creds.uid) {
            return dashboard(state, {type: 'bad', text: '请先保存带 UID 的机器人'});
        }
        const response = await postToTelegramApi(creds.token, 'sendMessage', {
            chat_id: creds.uid,
            text: '管理面板测试：双向机器人工作正常。群消息默认不会转发到这里。'
        });
        const payload = await response.json();
        const next = payload.ok ? await saveState(config.kv, pushLog(state, '测试私聊', creds.uid)) : state;
        return dashboard(next, {type: payload.ok ? 'ok' : 'bad', text: payload.ok ? '测试消息已发送，去 Telegram 看看' : (payload.description || '发送失败')}, JSON.stringify({ok: payload.ok, chat_id: creds.uid, message_id: payload.result?.message_id}, null, 2));
    }

    return new Response('Not Found', {status: 404});
}
