# T02 引擎候选证据：RyuuPlay（有界比较）

- 检索/取证日期：2026-09-20（本机时区 +08:00）
- 候选：`https://github.com/keeshii/ryuu-play`
- 固定修订：`9cd20b6a3232b77ac114fb45a3979d51a4332850`（master，提交时间 2026-06-18T14:47:32+02:00）[^rev]
- 方法：只读克隆到临时目录，读取 `package.json`、`LICENSE`、`README.md` 与下列源码文件；用 `public name: string = '...'` 统计卡名，用 `extends (PokemonCard|TrainerCard|EnergyCard)` 统计卡牌类。比较对象是冻结 T01 卡池（`data/decks/zh-cn-standard-2025-06-05-effect-matrix.json` 的 28 个效果身份）。未运行其服务器/客户端，未复制其代码。
- 未评估衍生 fork：差距在卡牌实现层（朱紫世代卡缺失），公开 fork 不会消除同名旧印次与效果身份的差异；按「不无限调研」约束停止于此。

[^rev]: 克隆当日的默认分支 HEAD；`git rev-parse HEAD` 复核为该值。

## 许可与依赖

| 项 | 结论 |
| --- | --- |
| 许可 | 根 `LICENSE` 为 MIT（Copyright (c) 2020 keeshii）；`packages/{common,sets,server,simple-bot}` 声明 MIT；`packages/cordova` 声明 Apache-2.0。仓库无 NOTICE 文件。MIT 允许复用，但需保留版权与许可声明。 |
| 形态 | npm workspaces：`@ptcg/common`（规则/序列化）、`@ptcg/sets`（卡牌实现）、`@ptcg/server`（express + socket.io + typeorm + sqlite3/mysql + nodemailer + jimp）、`@ptcg/play`（Angular 16 客户端）、`@ptcg/cordova`（Cordova 11 / cordova-android 9）、`@ptcg/simple-bot`。 |
| 引擎核心依赖 | `packages/common` 仅依赖 `@progress/pako-esm`；`packages/sets` 仅依赖 `common`。核心规则层的依赖负担很小。 |
| 工具链 | TypeScript `~4.9.5`；测试为 jasmine-ts / nyc；根 `scripts.test` 是未实现的占位。 |
| 维护取向 | README 明言「There is no plans to port all possible cards」，项目定位为 AI bot 试验平台。 |

## 首发效果覆盖（对照 T01 冻结卡池）

RyuuPlay 已实现的系列：Base/Fossil/Jungle/Team Rocket、EX 的 FRLG/Ruby&Sapphire/Sandstorm、DP、HGSS、BW/BW2/BW3/BW4、日文 OP9、少量剑盾文件（12 个）与 `common/trainers`。没有朱紫世代（SV）系列。统计到 862 个卡牌类声明、554 个唯一卡名。

| T01 效果身份 | RyuuPlay | 判定 |
| --- | --- | --- |
| 精灵球 `cbb1c-1701` | `common/trainers/poke-ball.ts`：硬币正面检索 1 张宝可梦后洗牌 | 语义一致 |
| 高级球 `cbb1c-1703` | `standard/set-black-and-white/ultra-ball.ts`：弃 2 张手牌检索宝可梦 | 语义一致 |
| 等级球 `cbb2c-1002` | `standard/set-black-and-white/level-ball.ts`：检索 HP≤90 宝可梦 | 语义一致 |
| 基本草/火/水/超能量 | Base 与 Ruby&Sapphire 的对应 `EnergyCard` | 语义一致（各 1 项，共 4 项） |
| 超级球 `cbb1c-1702` | 只有 `set-firered-and-leafgreen/great-ball.ts`：检索基础宝可梦放备战，且排除 ex | 同名不同效果 |
| 梦幻ex `csve1-056` | 只有 `set-black-and-white-3/mew-ex.ts`（Versatile/Replace，HP 120） | 同名不同效果 |
| 月石 `csve1-057` | 只有 `set-sandstorm/lunatone.ts`（Lunar Eclipse/Cosmic Draw，HP 60） | 同名不同效果 |
| 雷吉奇卡斯 `csve1-098` | 只有 `set-black-and-white-2/regigigas.ts`（Daunt/Heavy Impact，HP 130） | 同名不同效果 |
| 勇气护符、鼓励信、莉佳的邀请、深钵镇、古简蜗ex、古玉鱼ex、古剑豹ex、拖拖蚓、荧光鱼、仙子伊布V、仙子伊布VMAX、珠贝、营火专家、莎莉娜、藤树、捩木、熔岩瀑布之渊（17 项） | 无 | 缺失 |

结论：**7/28 效果身份可复用**，四套 T01 卡组的核心进攻手、进化线与支援者全部缺失；不存在「直接接上冻结卡表即可对局」的路径。

## 与 #3 契约要求的差距

| 契约要求 | RyuuPlay 现状（固定修订） |
| --- | --- |
| 命令 ID + 预期版本 + 幂等 | 无。`packages/server/src/game/core/game.ts` 的 `dispatch(client, action)` 直接执行动作，没有命令 ID、版本号或重复提交去重；只有 `maxInvalidMoves` 计数。 |
| 认证座位 | socket 层用 `this.client.id` 构造动作（`backend/socket/game-socket.ts`），座位由连接绑定；但 `Game.dispatch` 本身不再校验动作玩家与连接玩家是否一致。 |
| 待决选择 | 有 prompts 机制（`ChooseCardsPrompt` 等）并由客户端响应；但未见选择 ID 与版本、越权结算或「选择期间只允许结算」的边界约束。 |
| 终端结果 | `GamePhase.FINISHED` + `GameWinner`；纯本地状态，非稳定对外契约。 |
| 按座位投影 | 有 `backend/socket/state-sanitizer.ts`：隐藏自己牌库/奖赏卡与对手手牌/牌库/奖赏卡，并隐藏私密选择中的卡。但投影逻辑绑定其自有 socket 与 `StateSerializer`，序列化的隐藏卡用 `{id: 下标}` 占位（位置而非卡牌身份）。 |
| 稳定隐藏 ID | 引擎为每张实体卡分配稳定 `Card.id`（`state.cardNames` 下标，`setup-reducer.ts` 中逐张赋值），`CardSerializer` 对可见卡序列化该 `id`。按座位投影时 `state-sanitizer.ts` 会把隐藏区卡片整体替换为 Unknown `{id: 位置下标}`，真实稳定 id 不进入隐藏区；因此洗牌前后映射不会被暴露，但保证完全依赖这一条 sanitizer 路径，且可见卡仍携带稳定实例 id。 |
| 服务器随机 / 可控随机 | `server/src/game/core/arbiter.ts` 用 `Math.random()` 处理洗牌与硬币，无注入点，无法做确定性重放；`setup-reducer.ts` 的 `ShuffleDeckPrompt` 由该 Arbiter 在服务器侧结算。 |
| 确定性回放 | 有 `MatchRecorder`（对局记录），但随机不可控，无法按随机输入精确重放。 |
| 不把 UI 耦合进规则 | `common`/`sets` 本身与 UI 解耦；但会话、投影与动作分发都在 `server` 包内，与其 express/socket/DB 结构耦合。 |

## 决策

- **拒绝**：不把 RyuuPlay 作为首版直接依赖或分叉基线。理由是覆盖缺口（四套卡组均不可用）、契约缺口（命令/版本/幂等、可控随机、回放）与集成成本（需要把自己的会话边界再包一层，同时承担上游卡牌实现）。
- **采纳**：自建有限子集引擎，按 #3 固定契约接入；以冻结效果身份为键逐张实现并测试。探针起点为 `packages/rules-probe/`。
- RyuuPlay 的 MIT 代码可在未来按需借鉴（保留许可与署名），本次未复制任何代码。
