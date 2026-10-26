<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 项目：穿搭模拟

一个可自托管的 AI 换装应用。Next.js 16 + React 19 + Postgres 17 + pg-boss 队列 + fal.ai。

**这个项目里，错误是要花钱的。** 一次图像生成 $0.04–$0.075，一次队列 bug 可能让同一张图被计费两次。下面所有约定都源于这个约束。

---

## 铁律

违反任何一条都会造成真实损失。这些不是风格偏好。

1. **分清哪些脚本花钱。** `smoke:*` 与 `verify:fal-schema` 免费（用桩 provider）；`spike:fal` 真实调用 fal。改队列/Worker 用 `smoke:queue` 验收，**不要**用 `spike:fal`。

2. **不可逆操作前，先确认它可恢复。** 删除前用 `git ls-files <path>` 确认文件真的已被跟踪 —— 本仓库有过"整个 `src/lib/` 从未入库却准备 `rm -rf`"的险情。**"git 历史里有" 这句话必须先验证再说。**

3. **断言必须能真的失败。** 写完断言问自己：什么情况下它该红？本项目踩过两次坑：一次是空测（守卫条件没触发，测试绿但什么都没测到），一次是断言强于系统保证的性质（`localConcurrency > 1` 时 handler 启动顺序本就不受约束，严格相等会随机变红）。

4. **涉及花钱的改动，先在免费路径上验证。** 真实端点只留作最后一步的效果确认。

5. **迁移只能追加。** 不要改 `drizzle/` 里已有的 `.sql`，改 schema 后用 `drizzle-kit generate` 生成新的。

6. **依赖方向从外向内。** `providers/` 不 import `db/schema`；跨层共享的枚举放 `src/lib/domain.ts`。

7. **区分"可商用"与"能用"。** `models.config.ts` 的 `license` 字段是**给使用者的警示**，不是项目的自我审查。收录 `research` 模型是允许的（效果优先），但 README 的商用清单必须同步更新。

---

## 技能

| 技能 | 何时用 |
|---|---|
| [跑验收](#技能跑验收) | 改完代码，需要确认没坏 |
| [新增模型](#技能新增模型) | 要接入新的 fal 端点 |
| [改队列或 Worker](#技能改队列或-worker) | 动 `src/lib/queue/`、`generation/`、`worker/` |
| [改数据库 schema](#技能改数据库-schema) | 动 `src/lib/db/schema.ts` |
| [花钱验证端点效果](#技能花钱验证端点效果) | 需要真实调用 fal |
| [准备提交](#技能准备提交) | 收尾 |

---

### 技能：跑验收

**触发**：任何代码改动之后。

**步骤**
1. `npm run typecheck && npm run lint && npm test` —— 永远先跑这三个，免费且快（<1 秒）
2. 涉及数据库或队列时，追加 `npm run smoke:queue`（免费，需要 Postgres 在跑）
3. 涉及参数映射时，追加 `npm run verify:fal-schema`

**验收**：`tsc` 与 `eslint` 退出码为 0；`vitest` 全绿；`smoke:queue` 输出「全部通过」。

---

### 技能：新增模型

**触发**：要把一个新的 fal 端点加进注册表。

**步骤**
1. `src/lib/providers/models.config.ts` 加一条：`id` / `providerId` / `endpoint` / `kind` / `label` / `costUsdPerRun` / `license` / `tier`
2. `src/lib/providers/fal/paramMap.ts` 加该端点的参数映射函数（注意不同端点的参数名**完全不同**，例如 FASHN 用 `model_image`，apps-v2 用 `person_image_url`）
3. `registry.test.ts` 与 `paramMap.test.ts` 加断言
4. **用真实照片实测一次**（见「花钱验证端点效果」）

**验收**：`resolveModel(kind, { tier })` 能返回新模型；参数映射单测通过；有真实产物证明端点确实可用。

**⚠️ 不要跳过第 4 步。** 注册表是使用者选型的唯一依据，只凭官方文档就入库会让它出现一个没人验证过的选项。

---

### 技能：改队列或 Worker

**触发**：改动 `src/lib/queue/`、`src/lib/generation/`、`worker/`。

**步骤**
1. 改代码
2. 跑 `npm run smoke:queue` —— 它会 spawn 真实 worker 子进程跑真实装配，只把"调上游"换成桩 provider

**验收**：`smoke:queue` 的 A/B/C/D 四段全绿。

**⚠️ 一个真实存在过的 bug**：每次重试都是一次新的 `processGeneration` 调用，而 `claimGeneration` 只认领 `queued` 状态（可重试失败会把状态退回 `queued`）。如果重试路径里无条件调用 `adapter.submit()`，**同一张图会被计费两次**。最尖锐的场景是 `output_download_failed` —— 上游那边图已经生成并计费，只是我们没下载成功。

修复方式是复用已存在的 `providerJobId` 而不是重新提交，见 `process.ts`。回归测试是 `smoke-queue.ts` 的 C 段，它同时断言 `start=2`（确实发生了重试）与 `submit=1`（没有重复提交）。**第一条断言是防止第二条变成空测。**

---

### 技能：改数据库 schema

**触发**：改动 `src/lib/db/schema.ts`。

**步骤**
1. 改 schema
2. `./node_modules/.bin/drizzle-kit generate` 生成迁移
3. 检查生成的 SQL 是否符合预期
4. `./node_modules/.bin/drizzle-kit migrate` 应用
5. 用 `docker exec dressing-postgres psql -U dressing -d dressing -c "\d <表名>"` 核对真实表结构

**验收**：迁移文件内容与意图一致；`\d` 输出的列与 schema 一致。

**⚠️ 顺手检查**：删列/删枚举值时，用 `grep` 搜符号名**不够** —— 字符串字面量引用会被漏掉。本项目出现过 config 里以字符串形式引用已删 key、只有 `tsc` 抓到的情况。改完**必须**跑 `tsc`。

---

### 技能：花钱验证端点效果

**触发**：需要真实调用 fal（新增模型、改参数映射、核对效果）。

**步骤**
1. **先确认要用哪些端点**，用 `--only` 限定，别把三个都跑一遍：
   ```bash
   ./node_modules/.bin/tsx scripts/spike-fal.ts <人物照> <服装图> --only=fashn
   ```
2. 用真实全身照。合成剪影会让 FASHN 的姿态检测失败并返回 422（`Failed to detect body pose in model image`）
3. 产物落在 `spike-output/`（已 gitignore）

**验收**：产物能被解码，且**肉眼确认换装确实生效** —— 不能只看"成功"两个字。

**已实测的成本参考**：FASHN $0.075 / 100–260s；apps-v2 换装 $0.040 / 50s；换发型 $0.040 / 25s。

---

### 技能：准备提交

**触发**：改动完成，准备提交。

**步骤**
1. 跑完「跑验收」的全部项目
2. `git status --short` 确认没有把 `example/`、`.env`、`data/`、`spike-output/` 带进来（前两者已在 gitignore，但仍值得看一眼）
3. 提交信息写**为什么**，不只是改了什么

**验收**：工作区状态与预期一致；提交后 `git log --oneline` 可见。
