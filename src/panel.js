/**
 * Admin panel for installing webhooks and sending group notices.
 * Login uses ADMIN_PASSWORD from Cloudflare secrets.
 */

import {handleInstall, handleUninstall, postToTelegramApi} from './core.js';

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

async function makeCookie(secret) {
    const exp = Date.now() + SESSION_MS;
    const payload = `admin:${exp}`;
    const sig = await sign(secret, payload);
    return `${exp}.${sig}`;
}

async function hasSession(request, secret) {
    if (!secret) return false;
    const token = parseCookies(request)[COOKIE];
    if (!token || !token.includes('.')) return false;
    const index = token.indexOf('.');
    const exp = token.slice(0, index);
    const sig = token.slice(index + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const expected = await sign(secret, `admin:${exp}`);
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

function htmlPage(title, body, extraHeaders = {}) {
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
main { width:min(920px, calc(100% - 32px)); margin:32px auto 64px; }
h1 { font-size:28px; margin:0 0 8px; }
.sub { color:var(--muted); margin-bottom:24px; line-height:1.6; }
.grid { display:grid; gap:16px; }
@media (min-width:800px) { .grid-2 { grid-template-columns:1fr 1fr; } }
.card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px; }
.card h2 { margin:0 0 12px; font-size:18px; }
label { display:block; color:var(--muted); font-size:13px; margin:10px 0 6px; }
input, textarea { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:#0f1722; color:var(--text); font:inherit; }
textarea { min-height:110px; resize:vertical; }
.row { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
button { appearance:none; border:0; background:var(--accent); color:white; padding:10px 14px; border-radius:10px; font-weight:600; cursor:pointer; }
button.secondary { background:#2a3644; }
.flash { padding:12px 14px; border-radius:12px; margin-bottom:16px; line-height:1.5; }
.flash.ok { background:#123524; color:var(--ok); }
.flash.bad { background:#3a1518; color:#ffd0d0; }
.flash.info { background:#132033; color:#cfe3ff; }
pre { white-space:pre-wrap; word-break:break-word; background:#0f1722; padding:12px; border-radius:10px; overflow:auto; }
.top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:8px; }
code { color:#cfe3ff; }
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
            'Cache-Control': 'no-store',
            ...extraHeaders
        }
    });
}

function flashBox(flash) {
    if (!flash) return '';
    return `<div class="flash ${flash.type}">${escapeHtml(flash.text)}</div>`;
}

function loginPage(config, flash) {
    const setup = !config.adminPassword
        ? '<div class="flash info">还没有设置登录密码。到 Cloudflare Worker 的 Variables and Secrets 里新增加密变量 ADMIN_PASSWORD，保存后再刷新这个页面。</div>'
        : '';
    return htmlPage('管理登录', `
      <h1>双向机器人管理</h1>
      <p class="sub">不要再手动改安装链接。登录后可以开通双向、查看状态、关闭双向，以及往群里发通知。</p>
      ${setup}
      ${flashBox(flash)}
      <section class="card">
        <h2>登录</h2>
        <form method="post" action="/admin/login">
          <label for="password">管理密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" ${config.adminPassword ? 'required' : 'disabled'}>
          <div class="row"><button type="submit" ${config.adminPassword ? '' : 'disabled'}>登录</button></div>
        </form>
      </section>
    `);
}

function dashboard(flash, resultText = '') {
    return htmlPage('管理面板', `
      <div class="top">
        <div>
          <h1>管理面板</h1>
          <p class="sub">双向只转发私聊，群里别人说话不会进你私信。群通知和双向可以同时开。Bot Token 只会通过表单提交，不会出现在地址栏。</p>
        </div>
        <form method="post" action="/admin/logout"><button class="secondary" type="submit">退出</button></form>
      </div>
      ${flashBox(flash)}
      <div class="grid grid-2">
        <section class="card">
          <h2>1. 开通双向</h2>
          <form method="post" action="/admin/install">
            <label for="uid">管理员 UID</label>
            <input id="uid" name="uid" inputmode="numeric" required placeholder="一串数字">
            <label for="installToken">Bot Token</label>
            <input id="installToken" name="token" type="password" required>
            <div class="row"><button type="submit">安装 Webhook</button></div>
          </form>
        </section>
        <section class="card">
          <h2>2. 查看状态</h2>
          <form method="post" action="/admin/status">
            <label for="statusToken">Bot Token</label>
            <input id="statusToken" name="token" type="password" required>
            <div class="row"><button type="submit">查询</button></div>
          </form>
        </section>
        <section class="card">
          <h2>3. 关闭双向</h2>
          <form method="post" action="/admin/uninstall">
            <label for="uninstallToken">Bot Token</label>
            <input id="uninstallToken" name="token" type="password" required>
            <div class="row"><button class="secondary" type="submit">卸载 Webhook</button></div>
          </form>
        </section>
        <section class="card">
          <h2>4. 发送群通知</h2>
          <form method="post" action="/admin/notify">
            <label for="notifyToken">Bot Token</label>
            <input id="notifyToken" name="token" type="password" required>
            <label for="chatId">群 ID / 聊天 ID</label>
            <input id="chatId" name="chatId" required placeholder="群一般是负数">
            <label for="text">内容</label>
            <textarea id="text" name="text" required></textarea>
            <div class="row"><button type="submit">发送</button></div>
          </form>
        </section>
      </div>
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
    const webhook = hook.url ? maskWebhookUrl(hook.url) : 'not installed';
    return `bot: ${username} ${me.first_name || ''}\nwebhook: ${webhook}\npending: ${hook.pending_update_count ?? 0}`.trim();
}

export async function handleAdmin(request, config) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const loggedIn = await hasSession(request, config.adminPassword);

    if (path === '/admin' && request.method === 'GET') {
        return loggedIn ? dashboard() : loginPage(config);
    }

    if (request.method !== 'POST' || !isSameOrigin(request)) {
        return new Response('Forbidden', {status: 403});
    }

    if (path === '/admin/login') {
        const form = await readForm(request);
        if (!config.adminPassword) {
            return loginPage(config, {type: 'bad', text: '还没有设置 ADMIN_PASSWORD'});
        }
        if (!safeEqual(form.password, config.adminPassword)) {
            return loginPage(config, {type: 'bad', text: '密码不对'});
        }
        const cookie = await makeCookie(config.adminPassword);
        return redirect('/admin', {'Set-Cookie': cookieHeader(cookie)});
    }

    if (path === '/admin/logout') {
        return redirect('/admin', {'Set-Cookie': cookieHeader('')});
    }

    if (!loggedIn) {
        return loginPage(config, {type: 'bad', text: '请先登录'});
    }

    if (path === '/admin/install') {
        const form = await readForm(request);
        if (!form.uid || !form.token) {
            return dashboard({type: 'bad', text: '请填写 UID 和 Bot Token'});
        }
        const response = await handleInstall(request, form.uid, form.token, config.prefix, config.secretToken);
        const payload = await response.json();
        return dashboard(
            {type: payload.success ? 'ok' : 'bad', text: payload.message || JSON.stringify(payload)},
            JSON.stringify(payload, null, 2)
        );
    }

    if (path === '/admin/uninstall') {
        const form = await readForm(request);
        if (!form.token) {
            return dashboard({type: 'bad', text: '请填写 Bot Token'});
        }
        const response = await handleUninstall(form.token, config.secretToken);
        const payload = await response.json();
        return dashboard(
            {type: payload.success ? 'ok' : 'bad', text: payload.message || JSON.stringify(payload)},
            JSON.stringify(payload, null, 2)
        );
    }

    if (path === '/admin/status') {
        const form = await readForm(request);
        if (!form.token) {
            return dashboard({type: 'bad', text: '请填写 Bot Token'});
        }
        const [meRes, hookRes] = await Promise.all([
            postToTelegramApi(form.token, 'getMe', {}),
            postToTelegramApi(form.token, 'getWebhookInfo', {})
        ]);
        const me = await meRes.json();
        const webhook = await hookRes.json();
        if (!me.ok) {
            return dashboard({type: 'bad', text: me.description || 'Token invalid'}, JSON.stringify(me, null, 2));
        }
        const summary = summarizeTelegram(me.result || {}, webhook.result || {});
        return dashboard({type: webhook.result?.url ? 'ok' : 'info', text: summary}, JSON.stringify({
            bot: me.result?.username ? `@${me.result.username}` : me.result?.first_name,
            webhook: maskWebhookUrl(webhook.result?.url || ''),
            pending_update_count: webhook.result?.pending_update_count ?? 0,
            allowed_updates: webhook.result?.allowed_updates || []
        }, null, 2));
    }

    if (path === '/admin/notify') {
        const form = await readForm(request);
        if (!form.token || !form.chatId || !form.text) {
            return dashboard({type: 'bad', text: '请填写 Token、群 ID 和内容'});
        }
        const response = await postToTelegramApi(form.token, 'sendMessage', {
            chat_id: form.chatId,
            text: form.text
        });
        const payload = await response.json();
        return dashboard(
            {type: payload.ok ? 'ok' : 'bad', text: payload.ok ? '群通知已发送' : (payload.description || '发送失败')},
            JSON.stringify({ok: payload.ok, chat_id: form.chatId, message_id: payload.result?.message_id}, null, 2)
        );
    }

    return new Response('Not Found', {status: 404});
}
