# 阿里云部署记录

## 当前状态（2026-11-11 02:36 切换）

| 项 | 值 |
| --- | --- |
| 实例 | `i-2ze884ngsym9cm66sul2`（cn-beijing，公网 8.140.237.233） |
| 安装目录 | `/opt/kinna-agent` |
| Node | `/opt/node24/bin/node` v24.11.0（独立安装，不影响系统 Node 20） |
| 服务 | `kinna-agent.service`（enabled，Restart=always） |
| OneBot 端口 | 6201（等 NapCat 反向连） |
| HTTP API | 127.0.0.1:3100 |
| 数据库 | `/opt/kinna-agent/data/agent.sqlite` |
| 旧服务 | `qq-companion-bot.service` 已 stop + disable |

NapCat 的 `onebot11_3078163242.json` 里 `websocketClients[0].url` 已改为 `ws://127.0.0.1:6201/ws`。

## 验证结果

```
systemctl is-active kinna-agent        → active
ss -tnp | grep 6201                    → ESTAB（NapCat qq 进程已连上）
experience 表                          → self.reflection ×5、goal.revised ×4
                                          dream.completed ×1、memory.index.written ×1
journalctl -u kinna-agent              → 无 level 40/50 错误
```

self 在自动反思、改目标；Dream 已跑过一轮并写出记忆索引。

## 配置来源

`.env` 从旧 bot 的 `.env` **在服务器内部转换**，密钥没有经过命令行或日志：

| 旧 | 新 |
| --- | --- |
| `BOT_MODEL_API_KEY` | `LLM_API_KEY` / `QQ_MEDIA_API_KEY` |
| `BOT_MODEL_BASE_URL` | `LLM_BASE_URL` |
| `BOT_MODEL_NAME` | `LLM_MODEL` |
| `BOT_ONEBOT_TOKEN` | `QQ_ONEBOT_TOKEN` |
| — | `API_TOKEN`（随机生成 40 字符） |

`agent.qq.json`：三个群 `866795853 / 330707267 / 1127758474`，私聊白名单 + 管理员 `3485823460`。

## 回滚

```bash
# 1. 恢复 NapCat 配置
docker cp /opt/napcat-config-backup-202611110236.json napcat:/app/napcat/config/onebot11_3078163242.json
docker restart napcat
# 2. 换回旧服务
systemctl stop kinna-agent && systemctl disable kinna-agent
systemctl enable qq-companion-bot && systemctl start qq-companion-bot
```

旧 bot 的数据完整保留在 `/opt/kinna-releases/20261108-133650-memory-identity-final/data/`，**没有删除也没有迁移**。

## 数据迁移（2026-11-11 完成）

`scripts/migrate-legacy.py`，停服务 → 备份 → 迁 → 重启：

```
{"memories": 287, "people": 197, "relations": 3}
service: active
```

迁了三样：

| 旧 | 新 | 说明 |
| --- | --- | --- |
| `memories`（287） | `memories` | `user_id` → `subject_user_id`；`kind`/`revision`/`evidence` 补默认值 |
| `people`（197） | `documents(collection='people')` | 只有昵称，画像留给 Dream 慢慢写 |
| `relations`（3） | `documents(collection='rapport')` | `affection` → `score`，source 标 `import` |

验证：`about 3485823460` 有 **63 条**（和旧库一致），`factsAbout` 能查出具体内容——
「牢e的回复策略比较保守…」「压缩策略导致超时多次，所以记不住自己说的话」。

**消息没有迁**（7907 条）：新项目靠 experience 边跑边积累，旧消息结构差异太大。

### 一个遗留：索引没覆盖导入的记忆

`memory.index` 只有 1 条（新库 Dream 跑出来的「初到群里」），287 条导入的记忆**没有进目录**。

原因是索引由 Dream 从**经验流**提炼，不会自动把历史记忆编进去。

影响有限：`factsAbout`（认人）和 `memory.search`（检索）都**不依赖索引**，只有注入时那份
「我记得什么」的概览是空的。新对话会慢慢补上。

## 表情包（直接复用旧目录）

```bash
QQ_MEMES_PATH=/opt/kinna-releases/20261108-133650-memory-identity-final/memes
```

旧 `catalog.json` 的两种声明（`memes` 11 条 + `packs` 1 个）本项目都支持，格式无需转换。

验证：

```
标签数: 21 —— 卖萌、吃瓜、喜欢、困了、害羞、工作、开心、打call…
挑一张: astrbot-official-01/upstream/meow/file_5724095.jpg（119KB）
避开刚发的那张后: 换了          ← 去重逻辑在真实数据上有效
```

**注意**：路径指向旧 bot 的发布目录，将来清理 `/opt/kinna-releases` 会让它失效。
要长期稳定就把 `memes/` 复制到 `/opt/kinna-agent/memes` 并改这一行。

## 已知未做

| 项 | 说明 |
| --- | --- |
| **数据迁移** | 新库从零开始。旧库的 287 条记忆、7907 条消息、情绪/人物数据都没有搬过来 |
| 图片识别 | `QQ_VISION_MODEL` 已配（用同一个模型），但没在真实群图上验证过 |
| 表情包 | ✅ 复用旧目录（见下） |
| B 站 | 没配登录态，只能读不能写 |

## 部署时踩的坑

1. **服务器 npm 直连 registry.npmjs.org 超时** → 换 `registry.npmmirror.com`
2. **`npm install --omit=dev` 不装 typescript** → 构建放本地做，只传 `dist/`
3. **`.env` 不自动加载** → service 用 `bash -lc 'set -a; source .env; set +a; exec node ...'`（和旧 bot 一致）
4. **旧 .env 字段名完全不同**（`BOT_MODEL_*` vs `LLM_*`）→ 写转换脚本在服务器内部完成
5. **workbench 连接极不稳定**（多次 `connection closed` / `no route to host`）→ 把多步操作写成脚本一次执行
