/**
 * Cloudflare KV state for the admin panel.
 */

const KEY = 'panel-state';

export function emptyState() {
    return {
        password: null,
        forwardGroups: false,
        bots: [],
        logs: []
    };
}

export async function loadState(kv) {
    if (!kv) {
        return emptyState();
    }

    const raw = await kv.get(KEY);
    if (!raw) {
        return emptyState();
    }

    try {
        return {...emptyState(), ...JSON.parse(raw)};
    } catch (error) {
        return emptyState();
    }
}

export async function saveState(kv, state) {
    if (!kv) {
        throw new Error('PANEL_KV is not bound');
    }

    const next = {
        ...emptyState(),
        ...state,
        logs: (state.logs || []).slice(0, 30)
    };
    await kv.put(KEY, JSON.stringify(next));
    return next;
}

export function pushLog(state, action, detail) {
    const logs = [{t: Date.now(), action, detail}, ...(state.logs || [])].slice(0, 30);
    return {...state, logs};
}

function bytesToB64(bytes) {
    let text = '';
    bytes.forEach((byte) => {
        text += String.fromCharCode(byte);
    });
    return btoa(text);
}

function b64ToBytes(value) {
    const text = atob(value);
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

export async function hashPassword(password, saltB64) {
    const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        {name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 60000},
        material,
        256
    );
    return {
        salt: bytesToB64(salt),
        hash: bytesToB64(new Uint8Array(bits))
    };
}

export async function verifyPassword(password, record) {
    if (!password || !record?.salt || !record?.hash) {
        return false;
    }
    const next = await hashPassword(password, record.salt);
    return next.hash === record.hash;
}
