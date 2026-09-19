# @ptcg/rules-probe（T02 / #3 契约验证）

这是一个**有界规则探针**，不是完整游戏实现。它用冻结 T01 卡池中的少量真实卡牌验证「玩家命令 → 权威对局会话 → 按座位可见状态」这条边界，并固定后续正式引擎必须实现的会话契约。

包位置：`packages/rules-probe/`。规则代码不依赖 UI、网络、数据库或进程全局状态。

## 工具链与命令

| 项 | 值 |
| --- | --- |
| Node.js | >= 22（CI/本机验证使用 24.x） |
| TypeScript | 5.9.3（精确锁定；`@types/node` 24.13.6） |
| 构建 | `npm run build`（tsc，NodeNext ESM，输出 `dist/src/`） |
| 测试 | `npm test`（先构建，再 `node --test`，25 项） |
| 类型检查 | `npm run typecheck` |

依赖仅 `typescript` 与 `@types/node`；`package-lock.json` 一并提交。

## 会话契约

`src/contract.ts` 是唯一的公共边界。

- **命令**：`{ commandId, expectedVersion, type, ... }`。`commandId` 由客户端生成且唯一；重复 ID 返回首次结果（`duplicate: true`），不会二次执行；同一 ID 换载荷返回 `COMMAND_ID_REUSED`。`expectedVersion` 与当前版本不一致返回 `STALE_VERSION` 且不产生状态变化。
- **认证座位**：`session.submit(seatHandle, command)`。句柄由服务器创建（含随机 token），命令载荷里没有玩家身份，无法伪造或跨座。
- **待决选择**：同一时刻只有一个待决选择。选择未结算时，除结算者本人的 `resolve-choice` 外所有命令返回 `CHOICE_PENDING`；非选择者结算返回 `NOT_YOUR_CHOICE`。选择含 `choiceId`、范围 `min/max` 与临时候选引用；引用只在本次选择内有效。
- **终端结果**：`match-finished` 事件 + `result: { winner, reason }`；`reason` 为 `prizes | no-pokemon | deck-out | concede`。结束后所有命令返回 `GAME_FINISHED`。
- **随机性**：`RandomSource` 由服务器注入（正式服 `CryptoRandomSource`，测试 `SeededRandomSource`）。洗牌、硬币、抽牌都在服务器侧发生；视图与命令中没有种子、随机流或牌库顺序。
- **回放**：`session.record()` 返回服务器侧 `ReplayRecord`（卡表、座位名、随机输出序列、已接受命令）。`replayMatch(record)` 重新执行并返回逐步视图，任何分歧都会报错。

## 已支持的卡牌动作（有界）

| 卡（冻结效果身份） | 已实现 | 冻结数据依据 |
| --- | --- | --- |
| 古剑豹ex | 特性「战栗冷气」（战斗场，每回合 1 次，检索最多 2 张基本水能量）；招式「冰雹利刃」（水水，弃任意数量水能量，每张 60 伤害）；ex 昏厥拿 2 奖赏 | `csv3c-043` 全文与招式/特性 |
| 珠贝 | 支援者，每回合 1 张；检索水宝可梦 + 物品各 1 张 | `csve1-138`；「物品」**不包含宝可梦道具**（2025-01-17 规则，`rule_interactions`） |
| 高级球 | 物品；弃恰好 2 张手牌作为使用代价，然后检索 1 张宝可梦 | `cbb1c-1703` |
| 精灵球 | 物品；服务器硬币，正面才检索 1 张宝可梦 | `cbb1c-1701` |
| 基本草/火/水/超能量 | 附着（每回合 1 次）与能量提供 | 环境 `construction` / 基本能量规则 |
| 荧光鱼 | 招式「水枪」；作为昏厥测试目标 | `csve1-035` |
| 拖拖蚓 | HP/弱点/抗性元数据；招式与特性标记为未实现 | `csv3c-095` |
| 勇气护符 | 已知但**不可使用**（用于验证「物品」不检索宝可梦道具） | `csv1c-118` 与 2025-01-17 规则 |

其他卡牌在 `src/catalog.ts` 中不存在或 `implemented: false`；使用时会得到 `UNSUPPORTED_CARD`，不会被当成已支持。`test/frozen-consistency.test.mjs` 会把目录与冻结 JSON 逐字段核对（HP、属性、弱点、抗性、招式费用、规则交互），并确认探针卡组全部来自 T01 卡表。

## 隐藏信息保证

`viewFor(seat)` 返回该座位的投影：

- 自己：手牌（含手牌序号）、牌库/奖赏卡**只有张数**、弃牌区公开、场上宝可梦与附着公开。
- 对手：手牌/牌库/奖赏卡只有张数，弃牌区与场上公开。
- 搜牌候选只出现在选择者自己的 `pendingChoice` 中；对手只看到 `waitingForOpponentChoice: true`。
- 视图不包含内部实例 ID、洗牌顺序或种子。隐藏区永远序列化为 `{ count }`；因此洗牌前后不存在可用于跟踪的稳定隐藏 ID。
- 被检索并公开的卡通过 `cards-revealed` 事件进入双方公开记录，这是规则要求而非泄漏。

## 已知缺口（探针范围外）

- 开局只实现：洗牌、重抽（重抽后对手没有奖励抽卡）、6 张奖赏卡、放置战斗/备战宝可梦、先攻选择；未实现先攻首回合限制、进化、撤退/换位、宝可梦检查与特殊状态、同时昏厥、奖品卡手动选取顺序、卡组合法性完整校验（60 张/同名 4 张等）。
- 伤害实现弱点/抗性，但只覆盖单个战斗宝可梦；备战区伤害、附卡继承等未实现。
- 没有合法候选时（例如古剑豹ex 特性发动时牌库已无基本水能量），探针直接拒绝该命令，而不是打开空选择。
- 本探针只证明契约与代表性行为，不代表任一卡组可完整对局。
