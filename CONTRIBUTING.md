# 参与开发

感谢有兴趣。这个项目的核心约束是 **错误很贵** —— 一次图像生成 $0.04–$0.075，一次队列 bug 可能让同一张图被计费两次。所以下面关于"哪些脚本花钱"的部分请务必读一下，别误烧自己的额度。

---

## 上手

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate
```

跑测试：

```bash
npm run typecheck    # tsc
npm run lint         # eslint
npm test             # 单元测试（300+ 条），纯逻辑，不打网络
```

`npm test` **不需要任何 API Key，也不花钱**，改完随手跑。

---

## ⚠️ 哪些脚本花钱

这是新人最容易踩的坑。

| 脚本 | 花钱 | 说明 |
|---|---|---|
| `npm test` | 🆓 | 单元测试。全部 mock，不打网络 |
| `npm run smoke:upload` | 🆓 | 上传链路 |
| `npm run smoke:queue` | 🆓 | 队列端到端，用桩 provider 替代上游。需要 Postgres 在跑 |
| `npm run smoke:conversations` | 🆓 | 对话落库：幂等、`seq` 顺序、标题只写一次、跨会话读不到。需要 Postgres 在跑 |
| `npm run verify:fal-schema` | 🆓 | 用官方 OpenAPI schema 校验参数映射 |
| `npm run spike:fal` | 💰 | **真实调用 fal**。一次运行可能花掉 $0.15+ |

`smoke:*` 系列会 spawn 真实子进程、跑真实装配代码，只是把"调上游"换成假 provider —— 所以它验证的是真代码，却一分钱不花。**改动队列、Worker、认领、重试逻辑时，请用它做验收，不要用 `spike:fal`。**

`spike:fal` 是效果验证工具，需要真实照片：

```bash
./node_modules/.bin/tsx scripts/spike-fal.ts <你的全身照> <服装图> --only=fashn
# `example/` 不在仓库里（个人素材，已被 .gitignore 排除），用你自己的照片
```

`--only` 支持 `fashn` / `apps-v2` / `hair` 的任意组合，用来只跑其中一个，别为了改一个端点把三个都跑一遍。

---

## 代码约定

**把"为什么"写在代码旁边。** 这个项目的注释密度偏高，是刻意的 —— 线程池大小、重试策略、字段取舍这类决定，如果只写"做了什么"，三个月后没人敢改。示例：

```ts
// 每次只领 1 个。**不要调大**：handler 抛错会让整批任务一起失败重试，
// batchSize 为 1 才能让失败只影响自己。
batchSize: 1,
```

**测试要能真的失败。** 一个永远不会失败的断言比没有断言更糟 —— 它给人一种"验证过了"的错觉。写断言时问自己：什么情况下它该红？本项目已经在两处踩过这个坑（一次是空测没触发目标路径，一次是断言强于系统保证的性质导致随机变红）。

**先测再写。** 涉及花钱的改动，先用 `smoke:*` 或桩 provider 验证，最后才动真实端点。

---

## 常见任务

### 新增一个模型

三步，`src/lib/providers/` 内部闭环，**不需要**改编排、API 或前端：

1. `models.config.ts` 加一条（`id` / `endpoint` / `costUsdPerRun` / `license` / `tier`）
2. `fal/paramMap.ts` 加该端点的参数映射函数
3. `registry.test.ts` / `paramMap.test.ts` 加断言

**必须先在真实照片上实测再入库。** 只凭官方文档就加条目，会让注册表里出现一个没人验证过的选项 —— 而注册表是使用者选型的唯一依据。

`license` 字段是**给使用者的警示**，不是项目的自我审查：`commercial` 表示可放心商用，`research` 表示禁商用。收录 `research` 的模型是允许的（效果优先），但 README 的商用清单要同步更新。

### 改队列或 Worker

改完**必须跑 `npm run smoke:queue`**，它会验证：任务开始顺序大致按入队顺序（允许等于并发上限的错位）、并发不超上限、崩溃后对账恢复、以及**重试时不重复提交上游任务**。

最后一条尤其重要：每次重试都是一次新的 `processGeneration` 调用，而 `claimGeneration` 只认领 `queued` 状态 —— 如果重试路径里无条件调用 `adapter.submit()`，同一张图会被计费两次。这个 bug 真实存在过，回归测试在 `smoke-queue.ts` 的 C 段。

---

## 提交 PR

1. 跑通 `npm run typecheck && npm run lint && npm test`
2. 涉及队列的改动，再跑一次 `npm run smoke:queue`
3. PR 描述里写清楚**为什么**这么改，而不只是改了什么

CI 会跑 `typecheck` / `lint` / `test`，**不会跑 `smoke:*`**（需要 Postgres，且会 spawn 子进程），所以那一步得你本地跑。

---

## 项目结构

```
src/lib/db/           Drizzle schema 与连接
src/lib/domain.ts     跨层共享的领域枚举（只放真正的领域概念）
src/lib/providers/    Provider 抽象、模型注册表、fal 适配器
src/lib/generation/   单次生成的编排：认领 → 提交 → 轮询 → 转存 → 落库
src/lib/queue/        pg-boss 队列、入队、统计、Worker 装配
src/lib/storage/      StorageAdapter 与本地实现（R2 留同接口）
src/lib/image/        sharp 归一化与 EXIF 剥离
worker/               独立 Worker 进程入口
scripts/              验收脚本（smoke:* 免费，spike:* 花钱）
```

依赖方向**从外向内**：`providers/` 不 import `db/schema`，共享枚举放 `domain.ts`。

---

## 授权

提交贡献即表示你同意以 [Apache-2.0](LICENSE) 授权你的贡献。
