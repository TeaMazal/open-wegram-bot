/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

import {pushChat} from './store.js';

export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}

export function formatSenderName(sender, maxLength = 40) {
    const displayName = [sender.first_name, sender.last_name].filter(Boolean).join(' ');
    const username = sender.username ? `@${sender.username}` : '';
    const senderName = [displayName, username].filter(Boolean).join(' · ');
    const characters = Array.from(senderName);

    if (characters.length <= maxLength) {
        return senderName;
    }

    return `${characters.slice(0, maxLength - 1).join('')}…`;
}

export function messagePreview(message, maxLength = 200) {
    const parts = [];
    if (message.photo) parts.push('[图片]');
    else if (message.sticker) parts.push('[贴纸]');
    else if (message.animation) parts.push('[动图]');
    else if (message.video_note) parts.push('[视频留言]');
    else if (message.video) parts.push('[视频]');
    else if (message.voice) parts.push('[语音]');
    else if (message.audio) parts.push('[音频]');
    else if (message.document) parts.push(message.document.file_name ? `[文件] ${message.document.file_name}` : '[文件]');
    else if (message.contact) parts.push('[名片]');
    else if (message.location || message.venue) parts.push('[位置]');
    else if (message.poll) parts.push('[投票]');
    else if (message.dice) parts.push('[骰子]');

    const text = message.text || message.caption || '';
    const source = [...parts, text].filter(Boolean).join(' ').trim() || '[其他消息]';
    const characters = Array.from(source);
    if (characters.length <= maxLength) {
        return source;
    }
    return `${characters.slice(0, maxLength - 1).join('')}…`;
}

function visitorFromReplyMarkup(markup) {
    const button = markup?.inline_keyboard?.[0]?.[0];
    if (!button) {
        return null;
    }

    let visitorUid = button.callback_data || '';
    if (!visitorUid && button.url) {
        visitorUid = String(button.url).split('tg://user?id=')[1] || '';
    }
    if (!visitorUid) {
        return null;
    }

    const match = String(button.text || '').match(/From:\s*(.+)\s+\((\d+)\)\s*$/i);
    return {
        visitorUid: String(visitorUid),
        visitorName: match ? match[1].trim() : visitorUid
    };
}

async function recordPrivateChat(kv, botToken, record) {
    if (!kv) {
        return;
    }
    try {
        await pushChat(kv, botToken, record);
    } catch (error) {
        console.error('Error saving chat preview:', error);
    }
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message'],
            secret_token: secretToken
        });

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }

        return jsonResponse({success: false, message: `Failed to install webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error installing webhook: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {})

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully uninstalled.'});
        }

        return jsonResponse({success: false, message: `Failed to uninstall webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error uninstalling webhook: ${error.message}`}, 500);
    }
}

export async function handleWebhook(request, ownerUid, botToken, secretToken, forwardGroups = false, kv = null) {
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    const update = await request.json();
    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const isPrivate = message.chat && message.chat.type === 'private';
    if (!isPrivate && !forwardGroups) {
        return new Response('OK');
    }

    const reply = message.reply_to_message;
    try {
        if (reply && message.chat.id.toString() === ownerUid) {
            const visitor = visitorFromReplyMarkup(reply.reply_markup);
            if (visitor) {
                await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(visitor.visitorUid),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id
                });
                if (isPrivate) {
                    await recordPrivateChat(kv, botToken, {
                        direction: 'out',
                        ownerUid,
                        visitorUid: visitor.visitorUid,
                        visitorName: visitor.visitorName,
                        preview: messagePreview(message)
                    });
                }
            }

            return new Response('OK');
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        const sender = message.from || message.chat;
        const senderUid = sender.id.toString();
        const senderName = formatSenderName(sender);

        const copyMessage = async function (withUrl = false) {
            const ik = [[{
                text: `🔏 From: ${senderName} (${senderUid})`,
                callback_data: senderUid,
            }]];

            if (withUrl) {
                ik[0][0].text = `🔓 From: ${senderName} (${senderUid})`
                ik[0][0].url = `tg://user?id=${senderUid}`;
            }

            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: {inline_keyboard: ik}
            });
        }

        const response = await copyMessage(true);
        if (!response.ok) {
            await copyMessage();
        }

        if (isPrivate) {
            await recordPrivateChat(kv, botToken, {
                direction: 'in',
                ownerUid,
                visitorUid: senderUid,
                visitorName: senderName,
                preview: messagePreview(message)
            });
        }

        return new Response('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Internal Server Error', {status: 500});
    }
}

export async function handleRequest(request, config) {
    const {prefix, secretToken} = config;

    const url = new URL(request.url);
    const path = url.pathname;

    const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
    const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
    const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

    let match;

    if (match = path.match(INSTALL_PATTERN)) {
        return handleInstall(request, match[1], match[2], prefix, secretToken);
    }

    if (match = path.match(UNINSTALL_PATTERN)) {
        return handleUninstall(match[1], secretToken);
    }

    if (match = path.match(WEBHOOK_PATTERN)) {
        return handleWebhook(request, match[1], match[2], secretToken, config.forwardGroups, config.kv);
    }

    return new Response('Not Found', {status: 404});
}
