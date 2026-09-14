/**
 * Admin panel for installing webhooks and sending group notices.
 * Login uses ADMIN_PASSWORD or a password stored in KV.
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
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        out[key] = decodeURIComponent(value);
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
    const expected = await sign(cookieSecret(config), `admin:${exp}`);
    return safeEqual(sig, expected);
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
:root { --bg:#0f1419; --card:#18202b; --line:#2a3644; --text:#e7eef7; --muted:#93a4b7; --accent:#3d8bfd; --ok:#3dd68c; }
* { box-sizing:border-box; }
body { margin:0; font-family:ui-sans-serif,system-ui,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif; background:radial-gradient(1200px 500px at 10% -10%, #1b4f8a33, transparent), var(--bg); color:var(--text); }
main { width:min(980px, calc(100% - 32px)); margin:32px auto 64px; }
h1 { font-size:28px; margin:0 0 8px; }
.sub { color:var(--muted); margin-bottom:24px; line-height:1.6; }
.grid { display:grid; gap:16px; }
@media (min-width:800px) { .grid-2 { grid-template-columns:1fr 1fr; } }
.card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px; }
.card h2 { margin:0 0 12px; font-size:18px; }
label { display:block; color:var(--muted); font-size:13px; margin:10px 0 6px; }
input, textarea, select { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:#0f1722; color:var(--text); font:inherit; }
textarea { min-height:110px; resize:vertical; }
.row { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
button { appearance:none; border:0; background:var(--accent); color:white; padding:10px 14px; border-radius:10px; font-weight:600; cursor:pointer; }
button.secondary { background:#2a3644; }
button.danger { background:#8a2d2d; }
.flash { padding:12px 14px; border-radius:12px; margin-bottom:16px; line-height:1.5; }
.flash.ok { background:#123524; color:var(--ok); }
.flash.bad { background:#3a1518; color:#ffd0d0; }
.flash.info { background:#132033; color:#cfe3ff; }
pre { white-space:pre-wrap; word-break:break-word; background:#0f1722; padding:12px; border-radius:10px; overflow:auto; }
.top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:8px; }
.check { display:flex; gap:8px; align-items:center; color:var(--text); margin-top:12px; }
.check input { width:auto; }
.muted { color:var(--muted); font-size:13px; line-height:1.5; }
.list { display:grid; gap:8px; }
.item { display:flex; justify-content:space-between; gap:8px; align-items:center; background:#0f1722; border-radius:10px; padding:10px 12px; }
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

function botOptions(state, selected = '') {
    const bots = state.bots || [];
    const items = ['<option value="">手动填写</option>'].concat(
        bots.map((bot) => `<option value="${escapeHtml(bot.id)}" ${bot.id === selected ? 'selected' : ''}>${escapeHtml(bot.name || bot.uid || bot.id)}</option>`)
    );
    return items.join('');
}

function botList(state) {
    const bots = state.bots || [];
    if (!bots.length) {
        return '<p class="muted">还没有保存机器人。开通双向或查询状态成功后，可以勾选保存。</p>';
    }
    return `<div class="list">${bots.map((bot) => `
      <div class="item">
        <div>
          <strong>${escapeHtml(bot.name || '未命名')}</strong>
          <div class="muted">UID ${escapeHtml(bot.uid || '-')}</div>
        </div>
        <form method="post" action="/admin/bots/delete">
          <input type="hidden" name="id" value="${escapeHtml(bot.id)}">
          <button class="danger" type="submit">删除</button>
        </form>
      </div>`).join('')}</div>`;
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
    const setup = !config.adminPassword
        ? '<div class="flash info">还没有 Cloudflare 应急密码 ADMIN_PASSWORD。你可以先设它，或登录后在面板里设置面板密码。</div>'
        : '';
    return htmlPage('管理登录', `
      <h1>双向机器人管理</h1>
      <p class="sub">登录后可以开通双向、保存机器人、改密码、发群通知。Token 不会出现在地址栏。</p>
      ${setup}
      ${flashBox(flash)}
      <section class="card">
        <h2>登录</h2>
        <form method="post" action="/admin/login">
          <label for="password">管理密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <div class="row"><button type="submit">登录</button></div>
        </form>
      </section>
    `);
}

function dashboard(state, flash, resultText = '') {
    return htmlPage('管理面板', `
      <div class="top">
        <div>
          <h1>管理面板</h1>
          <p class="sub">默认只转发私聊。群通知和双向可以同时开。已保存的机器人下次不用重新粘贴 Token。</p>
        </div>
        <form method="post" action="/admin/logout"><button class="secondary" type="submit">退出</button></form>
      </div>
      ${flashBox(flash)}
      <div class="grid grid-2">
        <section class="card">
          <h2>1. 开通双向</h2>
          <form method="post" action="/admin/install">
            <label for="installBot">已保存的机器人</label>
            <select id="installBot" name="botId">${botOptions(state)}</select>
            <label for="uid">管理员 UID</label>
            <input id="uid" name="uid" inputmode="numeric" placeholder="一串数字">
            <label for="installToken">Bot Token</label>
            <input id="installToken" name="token" type="password">
            <label class="check"><input type="checkbox" name="saveBot" value="1" checked> 保存到面板，下次直接选</label>
            <div class="row"><button type="submit">安装 Webhook</button></div>
          </form>
        </section>
        <section class="card">
          <h2>2. 查看状态</h2>
          <form method="post" action="/admin/status">
            <label for="statusBot">已保存的机器人</label>
            <select id="statusBot" name="botId">${botOptions(state)}</select>
            <label for="statusToken">Bot Token</label>
            <input id="statusToken" name="token" type="password">
            <label class="check"><input type="checkbox" name="saveBot" value="1" checked> 保存到面板</label>
            <div class="row"><button type="submit">查询</button></div>
          </form>
        </section>
        <section class="card">
          <h2>3. 关闭双向</h2>
          <form method="post" action="/admin/uninstall">
            <label for="uninstallBot">已保存的机器人</label>
            <select id="uninstallBot" name="botId">${botOptions(state)}</select>
            <label for="uninstallToken">Bot Token</label>
            <input id="uninstallToken" name="token" type="password">
            <div class="row"><button class="secondary" type="submit">卸载 Webhook</button></div>
          </form>
        </section>
        <section class="card">
          <h2>4. 发送群通知</h2>
          <form method="post" action="/admin/notify">
            <label for="notifyBot">已保存的机器人</label>
            <select id="notifyBot" name="botId">${botOptions(state)}</select>
            <label for="notifyToken">Bot Token</label>
            <input id="notifyToken" name="token" type="password">
            <label for="chatId">群 ID / 聊天 ID</label>
            <input id="chatId" name="chatId" placeholder="群一般是负数" required>
            <label for="text">内容</label>
            <textarea id="text" name="text" required></textarea>
            <div class="row"><button type="submit">发送</button></div>
          </form>
        </section>
        <section class="card">
          <h2>5. 测试私聊</h2>
          <form method="post" action="/admin/test">
            <label for="testBot">已保存的机器人</label>
            <select id="testBot" name="botId">${botOptions(state)}</select>
            <label for="testToken">Bot Token</label>
            <input id="testToken" name="token" type="password">
            <label for="testUid">发给这个 UID</label>
            <input id="testUid" name="uid" inputmode="numeric" placeholder="通常是你的管理员 UID">
            <div class="row"><button type="submit">发送测试消息</button></div>
          </form>
        </section>
        <section class="card">
          <h2>6. 改登录密码</h2>
          <form method="post" action="/admin/password">
            <label for="currentPassword">当前密码</label>
            <input id="currentPassword" name="currentPassword" type="password" required>
            <label for="newPassword">新密码</label>
            <input id="newPassword" name="newPassword" type="password" minlength="6" required>
            <label for="confirmPassword">再输一次新密码</label>
            <input id="confirmPassword" name="confirmPassword" type="password" minlength="6" required>
            <p class="muted">改的是面板密码，保存在 Cloudflare KV 里，不进 GitHub。Cloudflare 的 ADMIN_PASSWORD 仍可应急登录。</p>
            <div class="row"><button type="submit">保存新密码</button></div>
          </form>
        </section>
      </div>
      <div class="grid grid-2" style="margin-top:16px">
        <section class="card">
          <h2>转发设置</h2>
          <form method="post" action="/admin/settings">
            <label class="check">
              <input type="checkbox" name="forwardGroups" value="1" ${state.forwardGroups ? 'checked' : ''}>
              允许把群消息也转到私聊
            </label>
            <p class="muted">默认关闭。只有你明确勾上，群里的话才会进管理员私信。</p>
            <div class="row"><button type="submit">保存设置</button></div>
          </form>
        </section>
        <section class="card">
          <h2>已保存的机器人</h2>
          ${botList(state)}
        </section>
      </div>
      <section class="card" style="margin-top:16px">
        <h2>操作记录</h2>
        ${logList(state)}
      </section>
      ${resultText ? `<section class="card" style="margin-top:16px"><h2>结果</h2><pre>${escapeHtml(resultText)}</pre></section>` : ''}
    `);
}

function redirect(location, headers = {}) {
    return new Response(null, {
        status: 303,
        headers: {Location: location, ...headers}
    });
}

async function readForm(request) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) {
        data[key] = String(value).trim();
    }
    return data;
}

function maskWebhookUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split('/');
        if (parts.length >= 2) {
            parts[parts.length - 1] = '***';
        }
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
    const saved = form.botId ? findBot(state, form.botId) : null;
    return {
        token: form.token || saved?.token || '',
        uid: form.uid || saved?.uid || '',
        saved
    };
}

async function persistBot(config, state, token, uid, enabled) {
    if (!enabled || !config.kv || !token) {
        return config.kv ? saveState(config.kv, state) : state;
    }
    let name = uid || 'bot';
    try {
        const meRes = await postToTelegramApi(token, 'getMe', {});
        const me = await meRes.json();
        if (me.ok) {
            name = me.result?.username ? `@${me.result.username}` : (me.result?.first_name || name);
            uid = uid || '';
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
    return await saveState(config.kv, pushLog({...state, bots}, '保存机器人', name));
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
        const cookie = await makeCookie(config);
        return redirect('/admin', {'Set-Cookie': cookieHeader(cookie)});
    }

    if (path === '/admin/logout') {
        return redirect('/admin', {'Set-Cookie': cookieHeader('')});
    }

    if (!loggedIn) {
        return loginPage(config, {type: 'bad', text: '请先登录'});
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
        const next = await saveState(config.kv, pushLog({...state, bots}, '删除机器人', removed?.name || form.id));
        return dashboard(next, {type: 'ok', text: '已删除保存的机器人'});
    }

    if (path === '/admin/install') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.uid || !creds.token) {
            return dashboard(state, {type: 'bad', text: '请填写 UID 和 Bot Token，或选择已保存的机器人'});
        }
        const response = await handleInstall(request, creds.uid, creds.token, config.prefix, config.secretToken);
        const payload = await response.json();
        let next = state;
        if (payload.success) {
            next = await persistBot(config, pushLog(state, '开通双向', creds.uid), creds.token, creds.uid, form.saveBot === '1' || !!form.botId);
        }
        return dashboard(
            next,
            {type: payload.success ? 'ok' : 'bad', text: payload.message || JSON.stringify(payload)},
            JSON.stringify(payload, null, 2)
        );
    }

    if (path === '/admin/uninstall') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token) {
            return dashboard(state, {type: 'bad', text: '请填写 Bot Token，或选择已保存的机器人'});
        }
        const response = await handleUninstall(creds.token, config.secretToken);
        const payload = await response.json();
        const next = payload.success
            ? await saveState(config.kv, pushLog(state, '关闭双向', creds.saved?.name || 'token'))
            : state;
        return dashboard(
            next,
            {type: payload.success ? 'ok' : 'bad', text: payload.message || JSON.stringify(payload)},
            JSON.stringify(payload, null, 2)
        );
    }

    if (path === '/admin/status') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token) {
            return dashboard(state, {type: 'bad', text: '请填写 Bot Token，或选择已保存的机器人'});
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
        const next = await persistBot(
            config,
            pushLog(state, '查询状态', me.result?.username ? `@${me.result.username}` : 'bot'),
            creds.token,
            creds.uid,
            form.saveBot === '1' || !!form.botId
        );
        const summary = summarizeTelegram(me.result || {}, webhook.result || {});
        return dashboard(next, {type: webhook.result?.url ? 'ok' : 'info', text: summary}, JSON.stringify({
            bot: me.result?.username ? `@${me.result.username}` : me.result?.first_name,
            webhook: maskWebhookUrl(webhook.result?.url || ''),
            pending_update_count: webhook.result?.pending_update_count ?? 0,
            allowed_updates: webhook.result?.allowed_updates || []
        }, null, 2));
    }

    if (path === '/admin/notify') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token || !form.chatId || !form.text) {
            return dashboard(state, {type: 'bad', text: '请填写 Token、群 ID 和内容'});
        }
        const response = await postToTelegramApi(creds.token, 'sendMessage', {
            chat_id: form.chatId,
            text: form.text
        });
        const payload = await response.json();
        const next = payload.ok
            ? await saveState(config.kv, pushLog(state, '群通知', form.chatId))
            : state;
        return dashboard(
            next,
            {type: payload.ok ? 'ok' : 'bad', text: payload.ok ? '群通知已发送' : (payload.description || '发送失败')},
            JSON.stringify({ok: payload.ok, chat_id: form.chatId, message_id: payload.result?.message_id}, null, 2)
        );
    }

    if (path === '/admin/test') {
        const form = await readForm(request);
        const creds = resolveCreds(form, state);
        if (!creds.token || !creds.uid) {
            return dashboard(state, {type: 'bad', text: '请填写 Token 和 UID，或选择已保存的机器人'});
        }
        const response = await postToTelegramApi(creds.token, 'sendMessage', {
            chat_id: creds.uid,
            text: '管理面板测试：双向机器人工作正常。群消息默认不会转发到这里。'
        });
        const payload = await response.json();
        const next = payload.ok
            ? await saveState(config.kv, pushLog(state, '测试私聊', creds.uid))
            : state;
        return dashboard(
            next,
            {type: payload.ok ? 'ok' : 'bad', text: payload.ok ? '测试消息已发送，去 Telegram 看看' : (payload.description || '发送失败')},
            JSON.stringify({ok: payload.ok, chat_id: creds.uid, message_id: payload.result?.message_id}, null, 2)
        );
    }

    return new Response('Not Found', {status: 404});
}
