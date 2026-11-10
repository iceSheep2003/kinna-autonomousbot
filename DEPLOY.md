# 部署

本地和服务器跑的是同一份代码、同一组能力开关，区别只在两件事：**浏览器从哪来**、**截图怎么给模型**。

## 1. 安装

```sh
npm ci              # 含 dev 依赖：构建和测试需要
npm run build       # 产物在 dist/src/main.js
```

运行时依赖只有 fastify / ipaddr.js / ws / zod；`playwright` 是可选依赖，只在读视频时用到。

## 2. 无头浏览器（读视频才需要）

```sh
npx playwright install chromium            # 推荐：由 playwright 管理版本
# 或复用已有浏览器二进制
BILIBILI_CHROME_PATH=/usr/bin/google-chrome
```

没装浏览器不会影响其他功能：`bilibili.video` 会返回一条明确的错误，读评论、出草稿照常。

## 3. 登录（扫码，不存密码）

```sh
KEY=$(curl -s -X POST -H "Authorization: Bearer $API_TOKEN" $BASE/v1/bilibili/auth/qr | jq -r .qrcodeKey)
# 用返回的 url 生成二维码，手机 B 站扫码
curl -s -H "Authorization: Bearer $API_TOKEN" $BASE/v1/bilibili/auth/qr/$KEY   # 直到 status=ok
```

会话落在同一个库里，带 `refresh_token`；之后每 6 小时检查一次是否该续期。

> **2026-11-10 实测**：B 站的自动续期依赖 `/correspond/1/{path}` 取 `refresh_csrf`，该路径现在在 www 与 passport 两个域都返回 404（不带 cookie 也一样），说明随前端改版失效。服务端会把续期失败报告成「自动续期不可用」，**当前会话照常可用**，只是到期后需要重新扫码。重新扫码只需再跑一次上面的命令。
把凭证放进环境变量（`BILIBILI_SESSDATA`/`BILIBILI_BILI_JCT`）也可以，适合密钥管理不想走扫码的场景。

## 4. 配置

复制 `agent.bilibili.example.json` 为部署配置，`AGENT_CONFIG` 指向它。登录态只走环境变量：

| 变量 | 用途 |
| --- | --- |
| `BILIBILI_SESSDATA` / `BILIBILI_BILI_JCT` | 登录态；缺一个就当未登录（能读不能写） |
| `BILIBILI_MID` | 自己的 mid；配置后轮询自己视频下的新评论 |
| `BILIBILI_CHROME_PATH` | 浏览器可执行文件；不填用 playwright 自带的 |
| `BILIBILI_SHOT_DIR` | 截图落盘目录，默认 `data/public/shots` |

## 5. 截图怎么给模型

`bilibili.video` 截完图要把图交给 DeepSeek 看，有两种方式：

- **本机（默认）**：不配 `bilibili.publicBaseUrl`，截图以内联 `data:` URL 进请求。不需要公网地址，也不需要隧道。单张约几十到上百 KB，6 张图仍远低于请求体上限。
- **服务器（推荐）**：配 `bilibili.publicBaseUrl` 指向 `BILIBILI_SHOT_DIR` 的公网地址，并把该目录用静态服务暴露在 `<publicBaseUrl>/shots/` 下。请求体只带 URL，带宽省下来。截图在 10 分钟后自动删除。

## 6. 启动

```sh
NODE_ENV=production node dist/src/main.js
```

反向代理只需要转发到 `127.0.0.1:3100`，并保持 `Authorization` 头。批准接口：

```sh
GET  /v1/bilibili/drafts
POST /v1/bilibili/drafts/:id/approve
POST /v1/bilibili/drafts/:id/reject   {"note":"..."}
```

## 7. 上线前自检

```sh
npx tsx scripts/verify-bilibili-local.mjs BV1GJ411x7h7
```

它真实访问 B 站：取视频信息 → 拉弹幕 → 选点 → 渲染流并截图 → 报告每张图大小（`ok: true` 表示不是纯黑帧）。
服务器上跑这一条就能确认浏览器、网络、防盗链 Referer 三件事都通。
