# Telegram 双向私聊机器人部署与运维教程

本教程适用于 [open-wegram-bot](https://github.com/wozulong/open-wegram-bot)，介绍如何把它部署到 Cloudflare Workers，并通过 Telegram Bot 接收访客消息和直接回复。

> 本文中的域名、UID、Bot Token 和 Secret Token 均为占位符。请替换为你自己的值，绝对不要把真实密钥提交到 GitHub、截图或发送给他人。

## 目录

- [一、工作原理](#一工作原理)
- [二、准备材料](#二准备材料)
- [三、创建 Telegram Bot](#三创建-telegram-bot)
- [四、获取管理员 UID](#四获取管理员-uid)
- [五、部署到 Cloudflare Workers](#五部署到-cloudflare-workers)
- [六、绑定自定义域名](#六绑定自定义域名)
- [七、安装 Webhook](#七安装-webhook)
- [八、验证收发消息](#八验证收发消息)
- [管理面板](#管理面板)
- [把机器人放进群当通知机器人](#把机器人放进群当通知机器人)
- [九、部署第二个或更多机器人](#九部署第二个或更多机器人)
- [十、停用、恢复和彻底作废机器人](#十停用恢复和彻底作废机器人)
- [十一、显示昵称、用户名和 UID](#十一显示昵称用户名和-uid)
- [十二、更新代码与重新部署](#十二更新代码与重新部署)
- [十三、常见报错排查](#十三常见报错排查)
- [十四、安全注意事项](#十四安全注意事项)
- [十五、最终检查清单](#十五最终检查清单)

## 一、工作原理

消息链路如下：

```text
访客 -> Telegram Bot -> Telegram Webhook -> Cloudflare Worker -> 管理员 Telegram
管理员回复转发消息 -> Cloudflare Worker -> Telegram Bot -> 原访客
```

这个项目不需要数据库。Worker 在转发给管理员的消息按钮里保存访客 UID；管理员使用 Telegram 的“回复”功能时，Worker 读取该 UID 并把消息复制给原访客。群聊、超级群和频道消息会被忽略，因此同一个机器人也可以进群发通知，而不会把群里的聊天同步到管理员私聊。

一个 Worker 可以安装多个 Bot。每个 Bot 使用自己的 Bot Token 和 Webhook，但可以共享同一个 Worker、域名、`PREFIX` 和 `SECRET_TOKEN`。

## 二、准备材料

部署前准备：

1. Telegram 账号。
2. Cloudflare 账号。
3. GitHub 账号，推荐先 Fork 项目，便于以后更新代码。
4. 一个 Telegram Bot Token。
5. 管理员 Telegram 数字 UID。
6. 一个符合要求的 `SECRET_TOKEN`。
7. 可选：已托管在 Cloudflare 的自定义域名。

本文统一使用以下占位符：

| 占位符 | 含义 | 示例格式 |
| --- | --- | --- |
| `YOUR_UID` | 接收消息的管理员 Telegram UID | 一串纯数字 |
| `YOUR_BOT_TOKEN` | BotFather 提供的 Bot Token | `数字:字符串` |
| `YOUR_SECRET_TOKEN` | Telegram Webhook 校验密钥 | 至少 16 位，含大小写字母和数字 |
| `YOUR_DOMAIN` | Worker 自定义域名 | `bot.example.com` |
| `YOUR_WORKER` | Cloudflare Worker 名称 | `open-wegram-bot` |
| `YOUR_PREFIX` | 安装和 Webhook 路径前缀 | 推荐 `public` |

## 三、创建 Telegram Bot

1. 在 Telegram 打开 [@BotFather](https://t.me/BotFather)。
2. 发送 `/newbot`。
3. 输入机器人显示名称。
4. 输入机器人用户名，用户名必须以 `bot` 结尾。
5. 保存 BotFather 返回的 Bot Token。

先验证 Token 是否有效。在浏览器中访问：

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getMe
```

成功时会返回包含 `"ok": true` 的 JSON。若返回 `Unauthorized`，说明 Token 填错、已撤销或已失效。

> Bot Token 相当于机器人密码。任何拿到它的人都可以控制机器人。

## 四、获取管理员 UID

向 [@userinfobot](https://t.me/userinfobot) 发送任意消息，记录返回的数字 ID。

注意：

- 使用数字 UID，不是 `@username`。
- UID 中不要有空格、引号或其他字符。
- 这个 UID 决定谁接收访客消息，也决定谁可以通过回复消息联系访客。

## 五、部署到 Cloudflare Workers

### 方案 A：GitHub 连接部署（推荐）

这种方式适合长期使用。GitHub 仓库更新后，Cloudflare 可以自动重新部署。

1. Fork [上游仓库](https://github.com/wozulong/open-wegram-bot) 到自己的 GitHub 账号。
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
3. 打开 **Workers & Pages**，创建应用并选择连接 Git 仓库。
4. 授权 Cloudflare 访问自己的 Fork，选择 `open-wegram-bot`。
5. 生产分支选择仓库实际默认分支，例如 `master`。
6. 如果页面要求填写部署命令，使用：

   ```bash
   npx wrangler deploy
   ```

7. 保存并部署，等待状态变为成功。

仓库的 `wrangler.toml` 应至少包含：

```toml
name = "open-wegram-bot"
main = "src/worker.js"
compatibility_date = "2023-05-18"
keep_vars = true

[vars]
PREFIX = "public"
```

`keep_vars = true` 用于减少代码重新部署时覆盖 Dashboard 变量的风险。敏感的 `SECRET_TOKEN` 不要写进这个文件。

### 方案 B：Wrangler 命令行部署

需要先安装 Node.js。然后执行：

```bash
git clone https://github.com/YOUR_GITHUB_NAME/open-wegram-bot.git
cd open-wegram-bot
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put SECRET_TOKEN
```

最后一个命令出现输入提示时，再输入真实的 `SECRET_TOKEN`。不要把密钥直接写进命令，因为命令可能被终端历史记录保存。

### 方案 C：Cloudflare Dashboard 手工编辑

这个项目由 `src/worker.js` 和 `src/core.js` 两个模块组成。手工粘贴时必须同时保留两个文件以及正确的 `import` 路径，漏掉 `core.js` 会导致部署或运行失败。

因此，Dashboard 手工编辑只建议用于临时修复；正式部署优先选择方案 A 或方案 B。修改后必须点击部署，单纯保存草稿不会更新线上 Worker。

### 配置环境变量

在 Worker 的 **Settings / Variables and Secrets** 中添加：

| 名称 | 值 | 类型 |
| --- | --- | --- |
| `PREFIX` | `public` | 普通文本变量 |
| `SECRET_TOKEN` | 自己生成的随机字符串 | 加密 Secret |

`SECRET_TOKEN` 必须：

- 长度至少 16 位；
- 同时包含大写字母、小写字母和数字；
- 不使用 Bot Token、生日、手机号或常用密码；
- 不提交到 GitHub；
- 不与其他网站密码共用。

添加或修改变量后，确认已经部署到当前生产版本。

## 六、绑定自定义域名

自定义域名不是 Cloudflare Worker 正常运行的绝对必要条件，但强烈推荐用于 Telegram Webhook，尤其是在 `workers.dev` 无法稳定访问的网络环境中。

1. 确认域名已经添加到当前 Cloudflare 账号。
2. 打开目标 Worker。
3. 进入 **Settings / Domains & Routes** 或 **Triggers**。
4. 点击 **Add / Custom Domain**。
5. 填写一个专用域名，例如 `bot.example.com`。
6. 等待证书和路由状态变为 Active。

测试根路径：

```text
https://YOUR_DOMAIN/
```

如果返回：

```text
Not Found
```

并且 HTTP 状态码是 `404`，通常说明域名已经正确到达 Worker，只是根路径本来就没有业务路由。这不是部署失败。

> 绑定域名后，旧 Webhook 不会自动改用新域名。必须重新执行下一节的安装地址。

## 七、安装 Webhook

先在 Telegram 私聊自己的机器人并点击 **Start**，然后在浏览器中访问：

```text
https://YOUR_DOMAIN/YOUR_PREFIX/install/YOUR_UID/YOUR_BOT_TOKEN
```

使用 `public` 前缀时是：

```text
https://YOUR_DOMAIN/public/install/YOUR_UID/YOUR_BOT_TOKEN
```

成功响应：

```json
{"success":true,"message":"Webhook successfully installed."}
```

然后检查 Telegram 记录的 Webhook：

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo
```

重点检查：

- `ok` 应为 `true`；
- `result.url` 应是当前使用的域名；
- `last_error_message` 应为空或不存在；
- `pending_update_count` 应逐渐回到 `0`。

安装地址和 `getWebhookInfo` 地址都包含 Bot Token。不要把它们发到群聊、Issue、公开日志或截图中。

## 八、验证收发消息

### 验证访客到管理员

1. 使用另一个 Telegram 账号打开机器人。
2. 点击 **Start**。
3. 发送一条普通文本或图片。
4. 管理员账号应收到转发消息。

### 验证管理员到访客

1. 管理员找到刚收到的消息。
2. 必须使用 Telegram 的“回复”功能回复该消息。
3. 不要另起一条普通消息。
4. 访客账号应收到回复。

机器人会忽略 `/start`，因此只发送 `/start` 不能验证转发是否正常。测试时再发送一条普通消息。

## 管理面板

不要再手动拼安装链接。部署后打开：

```text
https://YOUR_DOMAIN/admin
```

登录密码是 Cloudflare 加密变量 `ADMIN_PASSWORD`，不要用 `SECRET_TOKEN`，也不要写进 Git。

设置方法：

1. 打开 Cloudflare Dashboard
2. 进入 Worker `open-wegram-bot`
3. 打开 **Settings -> Variables and Secrets**
4. 添加 Secret：名称 `ADMIN_PASSWORD`，值据你自己的密码
5. 保存后打开 `/admin` 登录

面板里可以：

- 开通双向：填 UID 和 Bot Token
- 查看 Webhook 状态
- 关闭双向：卸载 Webhook，群通知不受影响
- 发送群通知：填群 ID 和内容

双向仍然只转发私聊。旧的 `/public/install/...` 链接还可用，但建议改用面板，避免 Token 进浏览器历史记录。

## 把机器人放进群当通知机器人

这个项目的双向功能只处理 **私聊**。把同一个机器人拉进群，用来发群通知，是可以的；但群里别人发的消息，不应该再转到管理员私聊。

当前代码会直接忽略这些会话类型：

- `group` 普通群
- `supergroup` 超级群
- `channel` 频道

也就是说：

- 用户私聊机器人：继续转发给管理员，管理员回复后仍可回给对方。
- 群成员在群里发消息：Worker 收到后直接丢弃，不再复制到管理员私聊。
- 机器人在群里发通知：不受影响。机器人自己发出的消息，Telegram 默认也不会再推回 Webhook。

建议同时在 BotFather 保持默认隐私模式：

1. 打开 [@BotFather](https://t.me/BotFather)
2. 发送 `/setprivacy`
3. 选择这个机器人
4. 选 **Enable**（开启隐私模式）

隐私模式开启后，机器人在群里默认看不到普通群消息，只能看到命令、点名或回复给它的内容。即使有人关掉隐私模式，Worker 端也会再挡一层，群消息仍然不会进管理员私聊。

部署这次代码后，不需要重新安装 Webhook。让群里再发一条测试消息，管理员私聊不应再收到。

## 九、部署第二个或更多机器人

不需要再创建一个 Worker。一个 Worker 可以服务多个 Bot：

1. 在 BotFather 再次发送 `/newbot`，创建新机器人。
2. 获取新机器人的独立 Bot Token。
3. 决定接收消息的管理员 UID，可以与第一个机器人相同，也可以不同。
4. 使用新 Token 再访问一次安装地址：

   ```text
   https://YOUR_DOMAIN/public/install/YOUR_UID/NEW_BOT_TOKEN
   ```

5. 使用 `getWebhookInfo` 验证新机器人的 URL。
6. 用另一个账号分别测试两个机器人。

注意：

- 每个机器人必须使用自己的 Token；
- 同一个 Bot 在 Telegram 中只能保留一个 Webhook；
- 对同一个 Bot 再次安装会覆盖它原来的 Webhook；
- 更新 Worker 代码会同时影响挂在该 Worker 上的所有机器人；
- 修改 `SECRET_TOKEN` 后，所有机器人都必须重新安装。

## 十、停用、恢复和彻底作废机器人

### 临时停用

访问：

```text
https://YOUR_DOMAIN/public/uninstall/YOUR_BOT_TOKEN
```

成功响应：

```json
{"success":true,"message":"Webhook successfully uninstalled."}
```

这只会删除 Webhook，不会删除 Bot，也不会让 Token 失效。

### 恢复机器人

重新访问安装地址即可：

```text
https://YOUR_DOMAIN/public/install/YOUR_UID/YOUR_BOT_TOKEN
```

### Token 泄露或彻底停用

如果 Token 曾出现在聊天、截图、浏览器共享画面、GitHub 或公开日志中，应立即在 BotFather 中撤销：

1. 打开 [@BotFather](https://t.me/BotFather)。
2. 发送 `/revoke`。
3. 选择对应机器人。
4. 获取新 Token。
5. 用新 Token 重新安装 Webhook。

旧 Token 被撤销后无法继续使用。只执行 `uninstall` 不等于撤销泄露的 Token。

## 十一、显示昵称、用户名和 UID

默认代码可能只显示用户名，或在没有用户名时显示昵称。若希望同时显示 Telegram 昵称、`@username` 和 UID，可在 `src/core.js` 中加入：

```js
export function formatSenderName(sender, maxLength = 40) {
    const displayName = [sender.first_name, sender.last_name]
        .filter(Boolean)
        .join(' ');
    const username = sender.username ? `@${sender.username}` : '';
    const senderName = [displayName, username].filter(Boolean).join(' · ');
    const characters = Array.from(senderName);

    if (characters.length <= maxLength) {
        return senderName;
    }

    return `${characters.slice(0, maxLength - 1).join('')}…`;
}
```

并把发送者名称计算改为：

```js
const sender = message.chat;
const senderUid = sender.id.toString();
const senderName = formatSenderName(sender);
```

按钮文字保持为：

```js
text: `🔏 From: ${senderName} (${senderUid})`
```

这样显示效果类似：

```text
From: 张三 · @zhangsan (123456789)
```

`maxLength` 用于避免 Telegram 按钮文字过长。修改后需要提交代码并重新部署 Worker。

## 十二、更新代码与重新部署

### 使用 GitHub 自动部署

1. 在自己的 Fork 中提交修改。
2. 查看 GitHub 提交是否成功。
3. 打开 Cloudflare Worker 的 Deployments。
4. 确认新版本部署成功，且对应正确的提交哈希。
5. 检查变量仍然存在。
6. 重新测试收发消息。

普通代码更新通常不需要重新安装 Webhook。以下情况需要重新安装：

- 更换 Worker 域名；
- 更换 `PREFIX`；
- 更换 `SECRET_TOKEN`；
- Bot Token 被撤销并生成了新 Token；
- Webhook 被其他服务覆盖。

### 使用 Wrangler 更新

```bash
git pull
npm install
npx wrangler deploy
```

部署后检查 `SECRET_TOKEN` 和 `PREFIX`，不要因为重新部署把变量清空。

## 十三、常见报错排查

### 1. Cloudflare Error 1101

`1101` 一般表示 Worker 执行过程中抛出了未捕获异常，或入口请求最终返回了运行时错误。它不等同于“没有绑定域名”。

按以下顺序检查：

1. 打开 Worker 的 **Logs / Observability**，查看同一时间的异常。
2. 检查入口文件是不是 `src/worker.js`。
3. 检查 `src/core.js` 是否存在、导入路径是否正确。
4. 检查 `PREFIX` 和加密的 `SECRET_TOKEN` 是否存在。
5. 检查最近一次部署是否成功。
6. 直接访问根域名，确认请求是否到达 Worker。
7. 分别测试 `workers.dev` 与自定义域名。

本次实际部署中，Worker 内部测试正常，但公开的 `workers.dev` 地址持续返回 500/1101，Telegram 因而无法回调。绑定自定义域名并用新域名重新安装 Webhook 后恢复。这个处理方法对类似网络或路由问题有效，但其他 1101 仍应以日志中的具体异常为准。

### 2. 根域名显示 `Not Found`

如果访问 `https://YOUR_DOMAIN/` 显示 `Not Found`，通常是正常现象。项目只处理以下路由：

```text
/{PREFIX}/install/...
/{PREFIX}/uninstall/...
/{PREFIX}/webhook/...
```

根路径没有页面，因此返回 404。

### 3. `Failed to install webhook: Not Found`

常见原因：

- URL 少了 `PREFIX`；
- `PREFIX` 实际值不是 `public`；
- 路径拼写错误；
- 域名没有路由到这个 Worker；
- Worker 线上版本不是当前源码。

先确认安装地址格式严格为：

```text
https://YOUR_DOMAIN/YOUR_PREFIX/install/YOUR_UID/YOUR_BOT_TOKEN
```

### 4. 安装成功但收不到消息

依次检查：

1. 是否给机器人发送了普通消息，而不仅是 `/start`。
2. `getWebhookInfo` 中的 URL 是否为当前域名。
3. `last_error_message` 是否包含 404、500、超时或证书错误。
4. `pending_update_count` 是否持续增加。
5. 管理员 UID 是否正确。
6. Worker 日志中是否有 Telegram API 错误。
7. Bot 是否被管理员账号屏蔽。

### 5. Webhook 返回 HTTP 500

HTTP 500 表示 Worker 代码执行失败。检查日志中的第一条异常，不要只反复访问安装链接。常见原因包括模块缺失、变量缺失、部署了错误分支或代码语法错误。

### 6. `pending_update_count` 一直增加

表示 Telegram 产生了消息，但 Webhook 没有成功消费。重点检查：

- Webhook URL 是否能从公网访问；
- 是否返回 2xx；
- Worker 是否超时或返回 500；
- 自定义域名证书是否正常；
- 近期是否更换了域名但没有重新安装。

修复后 Telegram 通常会继续重试，计数会逐步下降。

### 7. Token 无效或已过期

访问：

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getMe
```

如果返回 `401 Unauthorized`，回到 BotFather 检查 Token。Token 被 `/revoke` 后必须使用新 Token，并重新安装 Webhook。

### 8. 回复消息没有发给访客

- 必须回复机器人转发给管理员的那一条消息；
- 不要删除消息下方包含访客 UID 的按钮；
- 检查访客是否屏蔽了机器人；
- 检查 Worker 日志和 Telegram API 返回值。

### 9. 群里有人说话，管理员私聊也收到了

旧版本会把所有 `message` 都复制给管理员，包括群消息。当前代码只转发私聊。

如果改完代码后还在转发群消息：

1. 确认已经重新部署 Worker，而不是只改了本地文件；
2. 在群里再发一条新消息测试，旧消息不会自动撤回；
3. 确认测试的是这个已经更新的机器人，而不是另一个还在跑旧代码的 Bot。

## 十四、安全注意事项

### 必须遵守

- 永远不要把 Bot Token 或 `SECRET_TOKEN` 提交到 GitHub。
- 永远不要把真实 Token 写进教程、Issue、提交说明或截图。
- `SECRET_TOKEN` 必须作为 Cloudflare 加密 Secret 保存。
- Token 一旦公开，立即通过 BotFather `/revoke`，不要只删除消息。
- 不要把含 Token 的安装、卸载、`getMe` 或 `getWebhookInfo` 完整 URL 分享给他人。
- 定期查看 GitHub 提交历史和 Cloudflare 日志，确认没有密钥。
- GitHub 仓库公开时，提交前先做敏感信息扫描。

### 这个项目特有的风险

当前实现会把 Bot Token 放在安装 URL 和 Telegram Webhook URL 路径中，因此 Token 可能出现在浏览器历史、Cloudflare 请求日志或截图中。应做到：

1. 只在可信设备上执行安装。
2. 不共享包含地址栏的截图。
3. 不公开导出完整 Worker 请求日志。
4. 测试时若临时 Token 曾被分享，测试结束后立即撤销。
5. 不把安装 URL 收藏到会同步给他人的浏览器账号。

### `SECRET_TOKEN` 轮换

修改 `SECRET_TOKEN` 会让已有 Webhook 请求校验失败。轮换后必须对每个机器人重新访问安装地址，使 Telegram 保存新的 Secret Token。

## 十五、最终检查清单

部署完成后逐项确认：

- [ ] Bot Token 通过 `getMe` 验证。
- [ ] 管理员 UID 是纯数字且填写正确。
- [ ] Worker 最新部署状态为成功。
- [ ] `PREFIX` 与安装 URL 中的前缀一致。
- [ ] `SECRET_TOKEN` 已保存为加密 Secret。
- [ ] GitHub 中没有任何真实 Token 或 Secret。
- [ ] 自定义域名状态为 Active。
- [ ] 使用当前域名重新执行了安装 URL。
- [ ] 安装接口返回 `Webhook successfully installed.`。
- [ ] `getWebhookInfo` 显示当前域名，且没有持续错误。
- [ ] 另一个 Telegram 账号发送普通消息后，管理员能够收到。
- [ ] 管理员通过“回复”操作后，访客能够收到。
- [ ] 第二个机器人使用独立 Token 单独验证。
- [ ] 曾经公开过的临时 Token 已通过 BotFather 撤销。

完成这些检查后，机器人即可稳定使用。遇到问题时，优先同时查看 `getWebhookInfo` 与 Cloudflare 实时日志：前者说明 Telegram 看到了什么，后者说明 Worker 实际发生了什么。
