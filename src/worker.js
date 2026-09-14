/**
 * Open Wegram Bot - Cloudflare Worker Entry Point
 * A two-way private messaging Telegram bot
 *
 * GitHub Repository: https://github.com/wozulong/open-wegram-bot
 */

import {handleRequest} from './core.js';
import {handleAdmin} from './panel.js';

export default {
    async fetch(request, env, ctx) {
        const config = {
            prefix: env.PREFIX || 'public',
            secretToken: env.SECRET_TOKEN || '',
            adminPassword: env.ADMIN_PASSWORD || ''
        };

        const path = new URL(request.url).pathname;
        if (path === '/admin' || path.startsWith('/admin/')) {
            return handleAdmin(request, config);
        }

        return handleRequest(request, config);
    }
};
