# 首版构建与验证

本文记录本仓库当前可重复执行的构建、运行与验证命令，以及已固定下来的工具链版本。
每次改动实现后请按本文顺序重跑，验收证据以实际输出为准。

## 固定版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.19.0（`engines: >=24`） | 服务与工具链运行时；使用内置 `node:sqlite`，无原生编译依赖 |
| TypeScript | 7.0.2 | 三个包共用根 `tsconfig.base.json` |
| React / React DOM | 19.3.0 | 客户端界面 |
| Vite | 8.3.0 | 客户端构建 |
| Vitest + jsdom | 5.0.1 / 30.1.0 | 自动化测试 |
| Capacitor（core/cli/android） | 8.5.2 | 安卓外壳；`@capacitor/app` 8.1.1、`@capacitor/clipboard` 8.0.1、`@capacitor/preferences` 8.0.1 |
| ws | 8.21.3 | 服务端 WebSocket |
| Android Gradle Plugin | 8.13.0 | 由 Capacitor 模板固定 |
| Gradle | 8.14.3 | 由 `packages/client/android/gradle/wrapper/gradle-wrapper.properties` 固定 |
| Android compileSdk / targetSdk | 36 | 见 `packages/client/android/variables.gradle` |
| Android **minSdk** | **29（Android 10）** | 首版实际最低支持版本，写在 `variables.gradle` |

设备身份使用 ECDSA P-256（WebCrypto）。Android WebView 必须运行在安全上下文里
才提供 `crypto.subtle`，因此 `capacitor.config.ts` 固定 `androidScheme: 'https'`。

### 关键工具来源核对（2026-09）

本机 `.toolchain/` 缓存中的两个关键工具包已与官方发布摘要逐字节核对：

| 文件 | 本地 SHA-256 | 官方摘要 | 结论 |
| --- | --- | --- | --- |
| `gradle-8.14.3-bin.zip` | `bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531` | 与 `services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256` 一致 | 通过 |
| `openjdk-21.0.2_windows-x64_bin.zip` | `b6c17e747ae78cdd6de4d7532b3164b277daee97c007d3eaa2b39cca99882664` | 与 `download.java.net/…/openjdk-21.0.2_windows-x64_bin.zip.sha256` 一致 | 通过 |

说明：镜像只负责传输，上面两个值是与官方站点发布的摘要比对后才算通过。
Gradle wrapper 声明的 `-all.zip` 在本机网络下无法下载；APK 构建使用
`.toolchain/gradle-8.14.3/bin/gradle.bat`（由已核对的 `-bin.zip` 解压），与官方
`-all` 分发的差别仅是是否附带源码/文档，工具版本一致。

## 一次性准备

```bash
npm install                 # 安装工作区依赖，保留 package-lock.json
```

Android 侧需要 JDK 21 与 Android SDK（platform-tools、`platforms;android-36`、
`build-tools;36.0.0`）。JDK 版本由 `app/capacitor.build.gradle` 的 Java 21 目标
决定；本机已用 `.toolchain/jdk-21` 中的 OpenJDK 21.0.2 验证。SDK 路径写在
`packages/client/android/local.properties`（该文件按 Android 约定不入库）。

## 可重复命令

```bash
npm run build               # 依次构建协议、服务、客户端（客户端产物在 packages/client/dist）
npm test                    # 全部单元与集成测试（协议 130 项 / 服务 148 项 / 客户端 192 项，共 470 项）
npm run typecheck           # 三个包的类型检查
npm run test:e2e            # 端到端验收：真实服务进程 + 客户端连接代码（含断线/主动断开）
npm run test:e2e:rooms      # 房间端到端：真实服务 + 两客户端建房/加入/准备/唯一会话/第三人拒绝/房主离开
npm run check:release-bundle # 正式产物中不得出现明文地址或回环地址
npm run service:start       # 启动服务（默认 127.0.0.1:8787）
node tools/card-data/build-card-data.mjs                 # T01 卡牌资料校验
node --test tools/card-catalog/build-catalog.test.mjs    # T04 目录产物校验与构建测试
node --test tools/card-resources/build-resource-bundle.test.mjs # T15 资源包准备与校验测试
```

服务参数：`node packages/service/dist/main.js --host 127.0.0.1 --port 8787 --db ./ptcg-service.sqlite`，
可选 `--tls-cert/--tls-key` 启用 HTTPS/WSS。启动日志会输出 `pid`、`port`、
`protocolVersion`，便于核查。

### 构建 APK

开发变体（必须走 `android:sync:dev`，它会额外生成 debug 专属配置）：

```bash
npm run android:sync:dev -w @ptcg/client   # build:dev + cap sync + prepare-debug-android-assets.mjs
cd packages/client/android && gradlew assembleDebug
# 产物：packages/client/android/app/build/outputs/apk/debug/app-debug.apk
```

发布变体（不带签名，不带任何开发默认地址）：

```bash
npm run build && npm run android:sync -w @ptcg/client
cd packages/client/android && gradlew assembleRelease
# 产物：packages/client/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

在本机（无法访问 services.gradle.org）用 `.toolchain` 缓存构建时，把 `gradlew`
换成 `D:\…\.toolchain\gradle-8.14.3\bin\gradle.bat`，并设置 `JAVA_HOME`、
`ANDROID_HOME`、`GRADLE_USER_HOME` 指向 `.toolchain` 下对应目录。

## 卡牌目录与资源服务（T04）

目录产物由 T01 冻结资料确定性生成，提交在
`data/catalog/zh-cn-standard-2025-06-05-catalog.json`：

```bash
node tools/card-catalog/build-catalog.mjs          # 校验产物是最新的
node tools/card-catalog/build-catalog.mjs --write  # 资料变更后重新生成
node --test tools/card-catalog/build-catalog.test.mjs
```

产物的 `catalogVersion` 是目录内容（对象键排序）的 SHA-256；`dataRevision` 绑定
每个源资料的路径与哈希。每个 JSON 源资料都按 LF 规范化后的 UTF-8 字节计算
SHA-256，因此 `core.autocrlf=true` 的 CRLF 检出与 Linux LF 检出得到同一份
`sourceFiles`/`sourceDigest`，不把检出换行误报为资料变化；校验模式同样容忍
产物文件被检出工具写成 CRLF，但其他内容差异仍会失败。环境合法、效果支持、
卡图可用是三个独立标记：T04 阶段所有卡牌的“效果支持”都是“未接入”，客户端
不会把任何卡标成可对战。

服务接口（无鉴权，与健康检查同一端口）：

| 路径 | 说明 |
| --- | --- |
| `GET /catalog` | 完整目录 + 运行期覆盖；响应带 `ETag`（整份响应体的 SHA-256，包含运行期图片可用性），可用 `If-None-Match` 得到 304 |
| `GET /catalog/resources/{resourceId}` | T01 asar 资源样本图片（PNG）；不可用/未知返回 404 |
| `GET /catalog/card-images/{cardId}` | 本机配置的官方商品图（PNG）；不可用/未知返回 404 |
| `POST /decks/validate` | 按服务端当前目录独立校验卡组提交；只读卡组文档本身，客户端声明的合法/就绪字段无效；响应含环境、目录版本、资料修订、合法性、就绪状态与精确问题/卡牌 |

图片字节不入库。部署者用 `--resource-dir`（文件名取自目录清单）与
`--card-image-dir`（文件名为 `<cardId>.png`）指向本机导出目录；服务启动时逐个
校验 SHA-256，缺失或不一致只把该条目标为不可用，目录文字与版本仍然完整。
`--catalog` 可覆盖目录产物路径；对应环境变量为 `PTCG_CATALOG`、
`PTCG_RESOURCE_DIR`、`PTCG_CARD_IMAGE_DIR`。

```bash
node packages/service/dist/main.js --host 127.0.0.1 --port 8787 --db ./ptcg-service.sqlite \
  --resource-dir <样本目录> --card-image-dir <卡图目录>
curl -s http://127.0.0.1:8787/catalog | head -c 400
```

客户端目录行为：

- 首次在线成功后把完整目录写入 Capacitor Preferences 的当前槽；写入前复制旧值
  到备份槽，写入后回读校验，不一致时回滚。读取时当前槽损坏则回退备份槽。
- 每个信任边界（在线响应、缓存写入与缓存读取）都重算目录内容哈希；结构合法
  但 `catalogVersion` 与内容不符的响应不会发布到界面，也不会替换当前/备份缓存，
  界面明确显示“目录版本与内容不一致”并继续使用上一份完整缓存。
- 服务资料更新或目录读取失败不会清空/覆盖已有完整缓存；页面显示
  “目录版本 / 资料修订 / 来自服务或来自本机缓存”。
- 设置页与连接失败页在存在通过校验的完整缓存时提供「离线浏览卡牌目录」：
  冷启动且服务不可达时也能搜索并阅读 47 条缓存卡牌详情，页面标注
  “离线 · 未连接服务，本机缓存可读”，不冒充已连接的联机会话；返回键回设置。
- 同一内容版本下运行期图片可用性变化也会被持久化：服务 `ETag` 覆盖整份响应
  （内容 + 运行期覆盖），客户端同时比较内容版本与运行期覆盖；服务重启后新增
  或移除本机图片配置会在下一次刷新后反映到缓存与界面，不会错误沿用旧状态。
- 浏览目录期间断线不会把用户弹出到失败页：保留缓存并显示“离线 · 连接已断开”，
  可返回首页后重新连接；在线恢复后点“刷新目录”即可原子替换缓存。
- 搜索支持简中名称、商品/印刷编号、类别与效果摘要；同名不同效果与同效果重印
  按身份引用区分，不做名称合并。
- 无卡图时详情始终显示完整文字卡面；卡图与资源样本可在查看器中 100%–400% 放大。

## 卡组编辑、校验与分享（T05）

卡组文档与校验在 `packages/protocol` 的 `deck.ts` 中实现，服务端、客户端草稿与
文本导入导出共用同一实现。三个身份轴保持分离：`cardId`（具体印刷版本）、
`printIdentity`（商品+印刷编号）、`effectIdentity`（规则效果身份）。同名 ≤4
按目录的 `nameGroupKey`（官方卡名）聚合，因此异画和重印不能绕过限额；只按显示
名称猜测不同效果版本会被导入明确拒绝。基本能量不受同名限制，特殊限额按卡牌
子类型判定：棱镜之星同名 ≤1，王牌（ACE SPEC）与光辉宝可梦整副 ≤1。

“规则合法”与“效果已接入、可正式对战”是两个独立状态；校验同时要求精确 60 张、
≥1 张基础宝可梦、环境标记合法，并只有所有效果已接入才给出就绪。进化线完整性
只用于冻结预设的可玩性审查，不是通用的构筑合法性门槛：缺少进化前置的卡组在
规则上仍可合法。当前冻结目录全部为“效果未接入”，因此四套预设都只能编辑与
预览，不能开局。

文本格式带版本、环境与精确身份，可粘贴分享：

```text
PTCG-DECK/1
ENV zh-cn-standard-2025-06-05
4 csve1-062 print:CSVE1C:062 fx:pokemon:仙子伊布V:82add47b1578 # 仙子伊布V
```

导入也接受唯一卡名或卡牌编号的简化行；规范导出的身份令牌会转义空格等保留
字符，导入按 `print:` / `fx:` 标记锚定字段，因此含空格的规则身份（如
`fx:trainer:一击卷轴 愤怒之卷:...`）能无损往返。未知编号、同名歧义、身份与
环境不符、重复行合并超过单条目上限（99）都整体失败，界面不会覆盖原卡组。

客户端行为：

- 首页与设置页可进入「我的卡组」；四套冻结预设可预览或复制为草稿，复制保留
  精确身份，任何效果未接入的卡组都显示“正式对战未就绪”。
- 草稿保存在 Capacitor Preferences，每次变更立即落盘；离线可编辑、应用重启后
  恢复。编辑时可从缓存卡池搜索加卡、增减数量、重命名。本机草稿读取成功前
  禁止新建、复制或保存，读取失败时显示可重试的错误并暂停写入，避免把空列表
  当作现状覆盖设备上已有草稿。
- 导入成功时整份采用解析出的文档（含文本中的环境标识与卡牌），不会只换卡牌
  却沿用旧草稿的环境，留下混合语义。
- 离线校验使用本机完整缓存目录，界面标注环境、目录版本与资料修订；「用服务端
  当前目录校验」调用 `POST /decks/validate`，合法性与就绪状态只以服务端结果
  为准（客户端不提交任何合法/就绪声明）。
- 服务端校验对伪造提交独立重算：61 张、未知编号、身份不符、旧环境都返回自己的
  精确问题与涉及卡牌，供后续房间准备复用。

```bash
npm test -w @ptcg/protocol   # 含 deck.test.ts：校验、文本往返、同名/特殊限额
npm test -w @ptcg/service    # 含 deckValidation.integration.test.ts：真实目录 + HTTP
npm test -w @ptcg/client     # 含 deckFlow.test.tsx：预设/草稿/离线/服务端校验/导入
```

## 朋友房间与准备开局（T06）

房间准备契约在 `packages/protocol/src/room.ts`，服务端注册表在
`packages/service/src/rooms.ts`，客户端状态机在
`packages/client/src/rooms/roomController.ts`。握手完成后的 WebSocket 消息只
接受房间命令；命令带唯一 `commandId`，服务端按座位去重（相同 ID 的重传返回
同一结果），不重复生效。

- **房间码**：服务端用 `crypto.randomInt` 生成 6 位数字，冲突自动重试；已关闭
  房间码在短时间内保留墓碑，用来区分「不存在」与「已关闭」。客户端的房间码
  输入与服务地址是分开的两项；未收到服务端确认前不显示任何「房间可用」。
  「复制房间码」在原生 Android 上走官方 `@capacitor/clipboard` 插件（系统
  `ClipboardManager`），浏览器保留 `navigator.clipboard`；只有原生与 Web 都失败
  才提示手动抄写。
- **座位**：两个座位按设备恢复身份绑定，昵称只作显示。第三人得到
  `room-full`，同一设备重复加入回到原座位（含昵称更新与断线重连），没有
  旁观者视图；对手座位的卡组字段永远是 `null`，客户端解析器会拒绝携带对手
  卡表的载荷。
- **选卡组与准备**：`select-deck` 由服务端按当前目录独立校验（复用 T05 的
  `validateDeck`），换卡组立即撤销准备；`set-ready` 再次校验并把卡组、环境、
  `catalogVersion` 与 `dataRevision` 固定到座位。效果未接入的卡组只能得到
  `deck-not-ready` 与精确问题列表。
- **开局**：双方都就绪时只创建一次对局会话（唯一 `sessionId`、初始版本 1；
  同步注册表保证并发/重传不会创建第二场）。开局后不能再换卡组或取消准备。
- **离开**：开局前房主离开关闭房间并通知来宾；来宾离开释放座位、可重新加入；
  开局后离开只标记离线，保留座位与会话，重入仍是同一场对局，不构成认输。
- **限速**：加入尝试按设备滑动窗口限速，超出返回 `rate-limited` 与
  `retryAfterMs`。
- **命令路由与幂等**：房间快照携带稳定 `roomId`（与 6 位房间码分离，房间码
  关闭后会被回收复用）；选卡组/准备/离开命令必须携带 `roomId` 与
  `expectedVersion`。服务端按房间实例与版本校验：过期版本返回
  `version-conflict` 并回传当前个性化快照；指向其他实例或已释放座位返回
  `stale-room`/`not-in-room`；两者都不修改房间状态，客户端必须基于最新快照
  重新明确确认。相同 `commandId` 的精确重传（包括断线、离开/重入与房间码
  复用之后）返回第一次的结果，服务端按设备保留有界历史，不重复生效。
  建房/加入/选卡组/准备的直接结果（含错误）都携带原 `commandId`；客户端只
  采纳与当前等待命令匹配的直接结果，并用离开实例墓碑丢弃无命令关联的旧快照，
  因此旧命令的缓存快照/缓存错误（含跨房间重放）不会把界面切回已离开的房间，
  也不会在等待新房间响应时抢占窗口；服务端对当前命令的直接结果与显式重入
  不受墓碑限制。
- **修订一致性**：双方准备时校验冻结的环境、`catalogVersion` 与 `dataRevision`
  一致；目录在两次准备之间变化会撤销基于旧修订的准备并返回
  `catalog-changed`，要求重新确认后才建立唯一对局。服务端固定的是准备时
  独立校验过的确切卡组副本，客户端后续提交不会改变它。
- **版本与广播**：每个对授权座位可见的状态变化（加入座位、重连/昵称更新、
  在线状态、选卡组、准备/撤销、离开）都递增房间版本并只向两个授权座位
  发送个性化快照；客户端按 `(roomId, version)` 丢弃乱序旧快照，
  `room-left`/`room-closed` 也带实例与版本，旧命令的缓存结果不会把已重入
  的界面回退成已离开。

发行目录保持「全部效果未接入」，因此发行客户端能建房、邀请与选卡组，但任何
卡组都过不了准备校验。自动化验证在临时目录里从发行目录派生一份「效果已接入」
的夹具目录（重新计算内容哈希，见 `packages/service/test/support/roomTestKit.ts`
与 `scripts/e2e-rooms.mjs`）用于贯穿真实服务；夹具不进入仓库、APK 或发行目录。

```bash
npm test -w @ptcg/protocol   # room.test.ts：房间命令/快照解析、对手卡表泄露载荷被拒绝
npm test -w @ptcg/service    # roomFlow.integration.test.ts：真实服务 + 两客户端 + 测试夹具目录
npm test -w @ptcg/client     # roomController.test.ts / roomFlow.test.tsx：跨房间重放防护与建房/加入/选卡组/准备/开局/复制房间码
npm run test:e2e:rooms       # 真实服务进程端到端（含第三人拒绝与房主离开）
```

## 卡图资源准备与按需缓存（T15）

### 独立资源准备流程

资源准备与玩家 APK、规则代码分离，不提交图片字节，也不上传任何地方：

```bash
# 本机导出 T01 已核实官方图到 <inputs>（文件名用卡牌 id，如 csv3c-043.png），
# 逐张核对目录记录的 SHA-256、PNG 结构与竖版方向，生成版本化资源包。
node tools/card-resources/build-resource-bundle.mjs --inputs <inputs> --out <bundle>
node tools/card-resources/build-resource-bundle.mjs --inputs <inputs> --out <bundle> --check
node --test tools/card-resources/build-resource-bundle.test.mjs
```

- 资源包目录含 `manifest.json`（`bundleVersion`、每张卡的印刷身份、`sha256`、
  字节数、PNG 尺寸、官方文章地址与出处）与 `images/<cardId>.png`；
- 不能用扩展名、文件名或 `_en_` 猜测身份：输入字节哈希与目录
  `imageSource.sha256` 不一致即整包失败，不产生半成品；目录里没有映射的文件
  与目录没有声明官方图的卡都不会被采用；
- 清单与图片字节分离，仓库只保留工具与测试；T01 的 asar 资源样本继续只用于
  验证图片链路，不作为简中卡牌身份来源。

服务加载资源包（与 `--card-image-dir` 二选一）：

```bash
node packages/service/dist/main.js --host 127.0.0.1 --port 8787 \
  --resource-bundle <bundle>
```

启动时服务复核 `bundleVersion`、条目与目录 `imageSource` 的映射、每个文件的
大小与 SHA-256；失败条目保持“不可用”，目录文字与文字卡面完整。

### 客户端按需缓存

- 打开卡牌详情或资源样本查看器时才下载图片（目录列表不预取）；下载后先核对
  目录声明的 SHA-256，再以临时文件 + 改名原子写入应用私有目录
  `ptcg-image-cache/v1`（Capacitor Filesystem `Directory.Data`）。
- 缓存文件按内容哈希命名，每张卡保留有限个版本：目录哈希更新后下载失败、
  摘要不符或磁盘不足时，仍显示已缓存旧图并标注“更新失败”，文字卡面始终完整；
  缓存文件损坏会被识别、删除并回退到上一完整版本；自动重试有上限，同一张图
  不会每次启动重下。
- 设置页显示图片缓存张数与占用，可“刷新占用”与“清除图片缓存”；清除只作用于
  图片缓存命名空间，不删除设备身份、昵称、服务地址或后续卡组存储。
- 控制边界测试（`packages/client/test/imageCache.test.ts`、`imageCacheFilesystem.test.ts`、
  `cardImageCacheFlow.test.tsx`）覆盖：下载中断、摘要失败、空间不足、缓存文件损坏
  （含同进程同长度篡改按实际字节核对）、自动重试上限与显式重试、并发写入不同 key
  的索引串行提交、下载中清空缓存不复活、清理失败如实报告剩余占用、在线获取 →
  离线阅读 → 更新失败保留旧图 → 清缓存不损身份、服务端移除图片配置后仍读本机
  缓存，以及目录列表不预取。
- 命名空间边界测试覆盖：索引条目必须等于 `<sha256>.png`，穿越/绝对/子目录/任意
  文件名的索引整份作废且不按该名读取或删除；文件系统适配器读/写/删拒绝空名、
  `.`/`..`、路径分隔符与绝对路径，且 `readdir` 返回穿越名时 `clear` 不删除命名
  空间外文件并如实报告未清空；本模块自己的索引、内容哈希与派生临时/备份名仍可用。

```bash
npm run test -w @ptcg/client
```

### 卡图资源准备与按需缓存设备验收（2026-09-20，T15）

在 MuMu Player 12（Android 12 / SDK 32）`127.0.0.1:16384` 上用 ADB +
WebView CDP（回环端口 19327）完成一轮无人工点击的真实 APK 流程；本地服务使用
回环端口 8797。安装/更新后设备包 SHA-256
`F4C77586DC176219078D3C5AAF9E99A77E4A2EF6A5A0AC9DB6E9F0B35D0D469F` 与本地
`app-debug.apk`（源码提交 `42993fa`，复审修复后复验）一致：

- **资源包装载**：服务 A 以 `--resource-bundle` 装载独立准备流程产出的资源包，
  逐条复核清单版本（`848cafaed4ec…`）、印刷身份映射与文件哈希；目录
  `catalogVersion=66b351c87444…` 下卡图标记可用。
- **按需缓存**：打开目录列表并搜索到详情前，`files/ptcg-image-cache/v1` 为空；
  打开详情后才出现 `<sha>.png` 与 `index.json`，卡图与完整简中文字同时可读。
- **离线阅读**：停止服务并 `am force-stop` 后重新启动，从设置页进入离线目录，
  再打开同一张卡：已缓存卡图仍可阅读与放大，页面标注“离线 · 未连接服务”。
- **更新失败保留旧图**：切换到把同一卡图 `sha256` 指向另一张已核实图片的受控
  目录（`catalog-v2`），并用 CDP `Fetch` 拦断卡图请求；详情显示“卡图更新失败…
  正在显示已缓存旧图”与重试按钮，旧图与完整文字均保留。
- **显式重试原子替换**：关闭拦截后点击重试，新哈希图片写入
  `files/ptcg-image-cache/v1` 并替换索引条目，旧图提示消失，无需重启应用。
- **远程配置移除后仍读本机缓存**：服务端切换为不带图片目录、但目录仍声明同名
  哈希的受控配置（`runtime.cardImages[…].available=false`、`path=null`）；刷新
  后打开同一详情，卡图显示为本机完整缓存并标注“本机缓存”，不发起下载，完整
  文字逐字一致；恢复带图片目录的服务并重新刷新后，标识回到“卡图可用”。
- **占用与清除**：设置页显示“已缓存 N 张图片，占用 …”；点击“清除图片缓存”
  后占用归零、图片命名空间为空；预先创建的独立卡组命名空间探针
  `files/ptcg-decks/v1/probe` 与设备身份均保留。（#6 卡组存储尚未集成，此处
  只验证命名空间隔离，不代表卡组功能已可用。）
- **清缓存后文字兜底**：清缓存并断网重启后进入离线详情，卡图加载失败有明确
  提示与重试，完整文字卡面与冻结目录逐字一致。
- **隐私**：按当前 app PID + 新鲜时间戳过滤的 logcat 中身份私钥标量、`privateKey`
  与 Capacitor 插件载荷命中均为 0（`loggingBehavior: 'none'` 保持）。

设备阶段全程在全局 Windows 命名互斥锁 `Global\PTCGMobileDeviceValidation`
下执行：`tools/device-validation/invoke-with-device-mutex.ps1` 取锁后运行驱动，
`finally` 释放；锁被其它设备阶段（如并行的 #6）持有时立即以退出码 75 返回
`DEVICE_MUTEX_BUSY`，不轮询、不杀死持有者，由管理器稍后恢复。共享 5037 端口
与 MuMu 实例未被停止或修改，只清理本子创建的 `adb reverse/forward`、服务进程、
测试卡组探针与设备外临时图片副本。

证据保存在本机忽略目录 `.toolchain/issue16-run/device/`（`acceptance.log`、
`results.json`、`01`–`11` 阶段截图、`service-8797.log`、资源包 `manifest.json`、
`catalog-v2.json` 等），不随仓库提交。复现：

```powershell
# 1) 用显式本机目录的 T01 已核实卡图构建资源包
node tools/card-resources/build-resource-bundle.mjs --inputs <T01 卡图导出目录> --out .toolchain/issue16-run/device/bundle

# 2) 生成“更新后目录”夹具（默认复用 #5 设备验收的已核实图片，可用 PTCG_SOURCE_CARD_IMAGES 覆盖）
node .toolchain/issue16-run/device/prepare-catalog-v2.mjs

# 3) 按上文重建 debug APK，然后在全局互斥锁下运行设备驱动
powershell -NoProfile -ExecutionPolicy Bypass -File tools/device-validation/invoke-with-device-mutex.ps1 `
  -WorkingDirectory . -CommandLine "node .toolchain/issue16-run/device/device-image-cache-acceptance.mjs"
```

命名空间边界修复（索引只接受 `<sha256>.png`，文件系统适配器拒绝穿越/绝对名）
只由单元测试覆盖：它不改变 UI、正常缓存路径或既有文件名，未重建设备验收；上述
设备证据对应的源码提交为 `42993fa`。图片缓存索引提交失败共享文件的回滚修复
（`feafb41`）只改变失败路径，随下节合并后的整合验收一并覆盖。

### 合并 #6 后的整合设备验收（2026-09-20，T15 + T05）

在合并 `4a2b25b` 后重构建 debug APK，并在同一 MuMu Player 12
（`127.0.0.1:16384`，ADB + WebView CDP 回环 19327，服务回环 8797）完成第二轮
无人工点击的完整流程；设备包 SHA-256
`1FCA0DC453FEC30A2B36B60A65CC9E1ABC137658AC82CC21BE05C2F8FBE567D8` 与本地
`app-debug.apk`（源码提交 `52c9199`，含 `feafb41` 图片缓存回滚修复与 #6 合并）
一致：

- **资源包与目录**：服务 A 以 `--resource-bundle` 装载独立准备流程产出的资源包
  （`bundleVersion=848cafaed4ec…`，三条印刷身份与字节哈希逐条复核），目录
  `catalogVersion=2818ad7f5c9f…`（#6 LF 规范化后的产物）下卡图可用。
- **按需缓存与离线**：打开详情前 `files/ptcg-image-cache/v1` 为空；打开后出现
  `<sha>.png` 与 `index.json`；停止服务并 force-stop 重启后仍可离线阅读与放大，
  完整简中文字与冻结目录逐字一致。
- **更新失败与显式重试**：目录更新到 `catalog-v2`（csve1-035 指向另一张已核实
  图片）并拦断卡图请求时，详情保留旧图并显示“卡图更新失败…正在显示已缓存旧图”，
  重试后新哈希原子替换、无需重启。
- **远程配置移除后仍读本机缓存**：服务端不带图片目录时，详情仍显示本机完整缓存
  并标注“本机缓存”，不发起下载。
- **真实 #6 草稿**：在 UI 中从预设 A 复制草稿、重命名为“设备验收卡组”，编辑页
  显示 `共 60 张 · 环境 zh-cn-standard-2025-06-05`、仙子伊布V 计数 4，导出文本
  SHA-256 `53bdc83781118ee8…`，并等待草稿写入 Capacitor Preferences 后继续。
- **图片清除与草稿/身份保留**：设置页显示正数占用，点击“清除图片缓存”后
  `files/ptcg-image-cache/v1` 为空、占用归零；Capacitor Preferences 中真实草稿
  仍在，设备身份未变。
- **force-stop 重启**：断网重启后从设置页进入「离线管理我的卡组」，按草稿 id
  打开同一草稿，名称、`共 60 张`、仙子伊布V 计数 4 与导出文本 SHA-256 全部
  逐字节一致；设备身份与昵称保留。
- **清缓存后文字兜底**：离线详情加载卡图失败有明确提示与重试，完整文字卡面与
  冻结目录逐字一致。
- **隐私**：按 app PID + 新鲜时间戳过滤的 logcat（84 行）中身份私钥标量、
  `privateKey` 与 Capacitor 插件载荷命中均为 0。

证据保存在 `.toolchain/issue16-run/device/`（`acceptance.log`、`results.json`、
`01`–`13` 阶段截图，含 `12-deck-created`、`13-draft-after-restart`、
`service-8797.log`、资源包 `manifest.json`、`catalog-v2.json` 等），不随仓库提交；
同一驱动 `device-image-cache-acceptance.mjs` 已在全局互斥锁下可重复执行：UI 创建
真实 #6 草稿、等待 Preferences 写入、清图片缓存、force-stop 重启后按名称/张数/
导出字节复核，不使用命名空间探针替代。

**T15 未完成部分**（不得以模拟器或单元测试代替）：真机 Android 验收仍属父规格
要求，本轮结论全部来自模拟器；#6 卡组编辑与存储已随本次合并集成，草稿在清图片
缓存与重启后的保留已由上述整合验收覆盖。

**换行一致性修复（#6）**：此前在 `9a4ec3c`（含干净主工作区）上
`node tools/card-catalog/build-catalog.mjs` 会报告产物与资料不一致：
`data/catalog/zh-cn-standard-2025-06-05-resources.json` 的实际 SHA-256 与 T04
产物中记录的 `sourceFiles` 哈希不同（重算 `catalogVersion` 为 `daa8e806…` 而非
已提交的 `66b351c8…`）。该不一致已由 #6 修复：源资料按 LF 规范化的 UTF-8 字节
计算 SHA-256，产物校验同样容忍 CRLF 检出，`core.autocrlf=true` 与 Linux LF 得到
同一份 `sourceFiles`/`sourceDigest`。合并 `4a2b25b` 后
`node tools/card-catalog/build-catalog.mjs` 校验通过，
`catalogVersion=2818ad7f5c9f…`；本票后续设备验收使用该已提交产物。

## 传输安全策略

- 发布配置只接受 `https://` / `wss://`；`http://` / `ws://` 在界面层就被拒绝，
  不会发起任何网络请求（`parseServiceAddress` 的 `allowInsecure: false`）。
- 局域网明文只对开发配置开放：`vite build --mode development` 注入
  `allowInsecure: true` 与模拟器默认地址，正式构建注入空地址。
- Android 侧对应 `app/src/main/res/xml/network_security_config.xml`（禁止明文）
  与 `app/src/debug/res/xml/network_security_config.xml`（仅 debug 允许明文）。
- **WebView 混合内容**：debug 页面源是 `https://localhost`，DOM WebSocket 连
  `ws://` 会被 WebView 当作混合内容拦截，仅靠 network_security_config 不够。
  `scripts/prepare-debug-android-assets.mjs` 在开发同步后生成
  `app/src/debug/assets/capacitor.config.json`（`allowMixedContent: true`）；
  Android 资产合并时 debug 构建类型覆盖 main，release APK 物理上不含该文件，
  因此发布包仍是严格 HTTPS/WSS。
- 正式包不内置任何默认服务地址：`defaultServiceAddress` 在非 `DEV` 构建下为空，
  `npm run check:release-bundle` 会对构建产物做可执行检查。

### 在 APK 里核对（不只看源文件）

```powershell
# debug：allowMixedContent=true 且 loggingBehavior=none；release：两者均为 false/none
tar -xOf app-debug.apk assets/capacitor.config.json
tar -xOf app-release-unsigned.apk assets/capacitor.config.json
# 编译后的 network_security_config：debug=true，release=false
& $env:ANDROID_HOME\build-tools\36.0.0\aapt2.exe dump xmltree --file res/xml/network_security_config.xml app-debug.apk
```

### 恢复身份日志策略

`capacitor.config.ts` 固定 `loggingBehavior: 'none'`。Capacitor 原生桥默认只在 debug
构建里记录插件调用，但它把 `Preferences.set` 的完整载荷（包含恢复身份私钥）经
`Console` 插件写进 logcat；因此不能依赖“release 不可调试”，而是两个变体都显式关闭。
`scripts/prepare-debug-android-assets.mjs` 在调试资产里复制 main 配置时会检查该值，
缺失就直接失败，避免以后退回默认行为。

设备侧核对（不清空设备全局 logcat，只按 app PID + 新鲜时间戳过滤）：

```bash
adb shell pidof com.ptcgmobile.app
adb shell logcat -d -v epoch --pid <pid>
# 从应用私有存储取回身份，仅在本地脚本内存中比对；正确结果是 0 条命中，
# 且没有 Capacitor 的 LOG TO NATIVE / LOG FROM NATIVE 插件载荷行。
# 不要把私钥内容写进任何输出。
```

## 连接生命周期

握手成功后返回 `LiveConnection`（协议包）：

- `close()`：主动断开，幂等，不触发 `onClosed`（用户离开页面不是故障）。
- `onClosed()`：订阅非预期终止（服务端关闭、传输错误），最多回调一次；订阅时
  已断开会在微任务里补发。界面收到后切到「连接已断开」并提供重试/返回设置。
- App 卸载与替换连接时都会释放旧套接字；用尝试序号防止过期连接事件串扰新会话。

测试覆盖：协议层假 socket 生命周期、服务层真实 socket（客户端主动断开被服务端
日志观察到、服务端关闭后客户端收到一次通知、两条连接互不串扰）、App 组件卸载
释放、过期事件隔离，端到端脚本还会真实杀掉服务进程验证断线通知。

## 设备验收现状（2026-09-20）

已在 MuMu Player 12（Android 12 / SDK 32，2560×1440）的 `127.0.0.1:16384` 实例上
完成一轮无人工点击的 APK 验收（ADB + WebView DevTools CDP），安装包 SHA-256
`538C22CF96F8F8FA318BF2473F237FCDBA744EB23C894FC1967ECE567F3DFD94` 与本地
`app-debug.apk`（源码提交 72da5d3）一致：

- `pm clear` 全新启动 → 服务未启动也能到达设置页 → 输入昵称/地址 → 真实本地服务
  握手 → 中文连接首页 → 服务停止后提示断线 → 进程重启后昵称、地址、身份保留
  （服务端识别为已登记）→ 不可达 / 协议不兼容 / 原生证书错误三类失败均可理解并
  返回设置 → 返回键行为正确。
- 恢复身份日志：全新生成、普通保存、重置身份、进程重启四个路径，按 app PID +
  新鲜时间戳过滤的 logcat 均无身份私钥标量、无 `privateKey` 字段、无 Capacitor
  插件调用载荷（debug 构建也如此，见上文 `loggingBehavior: 'none'`）。
- 原生 `CapacitorHttp` 的 HTTPS 自签名证书错误在设备上确认归类为「证书无法验证」，
  并显示对应的 https 来源；此前「真机/模拟器文本待确认」的结论已由本轮模拟器
  证据取代。
- 真实软键盘（临时测试输入法）：MuMu 自带的 Sogou 只是 21 KB 虚拟输入桩，
  `Requested w=2560 h=0`，无法产生键盘像素。本轮从 HeliBoard 官方 GitHub 仓库
  （<https://github.com/HeliBorg/HeliBoard>，v4.1 release APK，本地 SHA-256
  `eb9c06685ebd5b7307491da9ef15fb5e29694077a934a8699b9b6772c6f76075`，与 GitHub
  发布摘要一致）临时安装并选中真实输入法，测量完成后按原值还原输入法设置并卸载。
  实测：`mImeHeight=736`、`ITYPE_IME visibleFrame=[0,704][2560,1440]`；应用视口
  `innerHeight=289` CSS px（dpr 2.25）的底边正好落在 IME 顶边 704 px，即
  `adjust=resize` 且无覆盖；昵称与地址在键盘弹出时可编辑；主按钮「保存并连接」
  滚动后完整位于视口内（底边 205 px < 704 px），键盘弹出时点击即完成真实握手；
  Android 返回键只收起键盘并留在设置页。键盘像素独立核对：底部 736 px 区域
  有/无键盘两张截图 99.9% 像素不同，返回后与无键盘截图仅 0.11% 不同。

证据保存在本机忽略目录 `.toolchain/issue4-run/device/`（`acceptance.log`、
`keyboard-acceptance.log`、`heiliboard-4.1/` 下的输入法来源/校验/还原记录、各阶段
截图、拉取的 APK 等），不随仓库提交。

### 卡牌目录设备验收现状（2026-09-20，T04）

在 MuMu Player 12（Android 12 / SDK 32）`127.0.0.1:16384` 上用同一套
ADB + WebView CDP 完成真实 APK 流程，安装/更新后设备包 SHA-256
`696C5B176A80EE55824960DAB45979D2C5498C8EFF5E4D10A2F6860DADF0AF9A` 与本地
`app-debug.apk`（源码提交 31be3ee）一致：

- 目录首页显示冻结环境 `2025-06-05`、`47 张已核实 / 四套卡组使用 28 张`、
  “不是完整标准卡池”；47 条全部显示“效果未接入”，没有“效果已支持”。
- 搜索“古剑豹”得到 1 条并进入详情；详情的完整简中文字与冻结目录产物逐字节一致，
  三项状态（环境合法 / 效果未接入 / 卡图可用）独立显示。
- 本机配置的 T01 官方商品图与 asar 资源样本都能经资源服务加载并放大（150% / 200%）。
- `Emulation.setDeviceMetricsOverride` 360×640 CSS 视口下，一击卷轴长文本（250 字）
  完整落在 DOM 中且可滚动阅读。
- 停止服务后目录仍列出 47 条、显示“来自本机缓存（断网可读）”；重启服务刷新后
  切回“来自服务”，缓存版本被替换。
- **离线冷启动**：在线加载过一次后停止服务并 `am force-stop`，重新启动应用；
  设置页在缓存校验完成后提供「离线浏览卡牌目录」，无需成功握手即可进入目录。
  页面显示“离线 · 未连接服务，显示本机缓存”，47 条可搜索（“古剑豹”→详情全文
  与冻结产物逐字节一致），返回键/按钮回到设置；重启服务并重新连接后目录切回
  “来自服务”。
- **同一内容版本下的运行期图片变化**：服务重启时移除 `--resource-dir`/
  `--card-image-dir`，客户端刷新后列表与详情立即回到“文字卡面”与文字兜底；
  重新加入图片配置后，携带旧 `ETag` 的条件请求得到 200（整份响应体的 ETag
  已变化），刷新后卡图恢复可放大。同一内容的 `catalogVersion` 全程不变。
- 按 app PID + 新鲜时间戳过滤的 logcat 中身份私钥、`privateKey`、Capacitor 插件
  载荷命中均为 0（`loggingBehavior: 'none'` 保持）。

证据保存在本机忽略目录 `.toolchain/issue5-run/device/`（`acceptance.log`、
`results.json`、各阶段截图（`01`–`16`，含 `11/12-runtime-*`、`13/14/15-cold-offline-*`、
`16-online-after-cold-offline`）、拉取的 APK、服务日志等），不随仓库提交；由
`.toolchain/issue5-run/device/device-catalog-acceptance.mjs` 可重复执行。

**T04 仍未完成**（不得以模拟器或文字测试代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 双客户端联机、完整对战与目标性能属于后续票。

### 卡组编辑与校验设备验收现状（2026-09-20，T05）

在 MuMu Player 12（Android 12 / SDK 32）`127.0.0.1:16384` 上用同一套 ADB +
WebView CDP 完成真实 APK 流程，安装包 SHA-256
`ED8DBA969F8002EB26540BF2EBA938A749870F4BEB9F9F5734B8D168F81FADA4` 与本地
`app-debug.apk`（源码提交 e8a5d78）一致；服务端目录版本
`2818ad7f5c9f…`（按规范 LF UTF-8 文本哈希重新生成）：

- 首页进入「我的卡组」：四套预设全部显示“规则合法 · 效果未接入，正式对战未就绪”，
  无一套充当可对战；预览 A 显示 ×4 与完整卡表。
- 复制为草稿后离线校验标注本机缓存环境/目录版本/资料修订；「用服务端当前目录
  校验」返回服务端环境与版本，并明确拒绝把效果未接入的卡组标为可正式对战。
- 从缓存卡池加卡到 61 张立即出现“卡组共 61 张，必须正好 60 张”的精确问题；减回
  60 张恢复。
- 导出文本含 `PTCG-DECK/1`、`ENV`、`print:` 与 `fx:` 身份；错误文本（环境不符、
  未知编号）导入失败且原 60 张卡组不变；导出文本原样导入成功。
- 停止服务后 `force-stop` 冷启动：设置页进入「离线管理我的卡组」，重命名后的
  草稿与 60 张构筑完整恢复；返回键路径为编辑 → 卡组列表 → 设置。
- 按 app PID + 新鲜时间戳过滤的 logcat 中恢复身份私钥、`privateKey`、Capacitor
  插件载荷命中均为 0（`loggingBehavior: none` 保持）。

证据保存在本机忽略目录 `.toolchain/issue6-run/device/`（`acceptance.log`、
`results.json`、各阶段截图、拉取的 APK、服务日志等），由
`.toolchain/issue6-run/device/device-deck-acceptance.mjs` 可重复执行；设备阶段由
`hold-device-lock.ps1` 持有跨代理 `PTCGMobileDeviceValidation` 互斥锁，避免与
并行工作树同时操作模拟器。

**T05 仍未完成**（不得以模拟器或文字测试代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 房间准备、双客户端联机与完整对战属于后续票；本票只交付可供房间准备复用的
  服务端校验接口。

### 朋友房间与准备开局设备验收现状（2026-09-20，T06）

在 MuMu Player 12（Android 12 / SDK 32）`127.0.0.1:16384` 上用同一套 ADB +
WebView CDP 完成真实 APK 流程，安装包 SHA-256
`FB3FAC5DF577327BF164FD0E96345F98900DDB906AD0F672310C98D051A07150` 与本地
`app-debug.apk`（源码提交 8e77a37）一致。本轮是两个真实客户端：一台安卓 APK +
一个主机 Node 进程（使用已构建的协议包），服务端为构建后的真实服务进程：

- 服务进程以测试夹具目录启动（从发行目录派生、重新计算内容哈希，夹具目录版本
  `1cfd3607…`）；发行目录本身仍全部“效果未接入”，测试夹具只存在于本机忽略目录。
- 设置页连接真实服务后进入「朋友房间」：页面显示当前服务地址，房间码是独立的
  6 位数字输入；建房得到房间码 `084779`（6 位数字）并显示「复制房间码」按钮。
  CDP 合成触控不具备用户激活上下文，WebView 拒绝了剪贴板写入，界面按设计回退到
  “复制失败，请手动抄写：084779”；本轮只验证复制入口与回退提示（系统剪贴板写入
  已由后续原生插件轮补验，见下）。
- 主机进程第二客户端加入同一房间并占座、选卡组并准备；设备端只看到对手“已加入、
  已准备”，设备 DOM 内不出现对手任何卡牌编号。
- 设备从预设复制 60 张草稿、在房间内选择后由测试夹具目录判为可正式对战，点击
  「准备」后双方就绪：设备与主机客户端看到同一会话 ID
  `4ae35690-80cc-4be5-a605-fe248ab2830a` 与初始版本 `v1`，服务端只记录一次
  `room.match_created`。
- 开局后点「返回首页（不认输）」：会话与版本不变，重进房间仍显示同一对局；
  主机侧看到对手仍占座（离线后重入恢复同一座位）。
- 切换回发行目录并重启服务后，应用重连、再建房、选卡组、点「准备」，服务端明确
  拒绝并给出“16 种卡（共 60 张）效果未接入，不能用于正式对战”的具体问题，证明
  发行目录没有被测试夹具“点亮”。
- 按 app PID + 新鲜时间戳过滤的 logcat（84 条新鲜行）中身份私钥标量、`privateKey`
  与 Capacitor 插件载荷命中均为 0（`loggingBehavior: none` 保持）。

修复轮复验（同日，源码提交 c7141d9，APK SHA-256
`5A329E1AD1AC2C4BE28E9B3666DC84C3477572D66D9CE366E69237DB89705872`，与本地
`app-debug.apk` 一致）：

- 命令现在以稳定 `roomId` 与 `expectedVersion` 路由；安卓 APK 与主机 Node 客户端
  走通“建房 → 加入 → 双方选卡组/准备 → 唯一会话 v1 → 开局后返回 UI → 重入”
  完整链路，主机侧原始载荷仍不含对手卡表。
- **复制操作改为 ADB 真实物理点击**（非 CDP 合成触控）：脚本先取复制按钮的
  `getBoundingClientRect`，按 `devicePixelRatio=2.25` 与应用窗口原点（dumpsys
  frame `0,0,2560,1440`）换算出屏幕坐标 `(1459, 617)`，再执行
  `adb shell input tap 1459 617`。该轮界面显示“复制失败，请手动抄写：987075”：
  真实用户激活下 MuMu Android 12 WebView 仍拒绝 `navigator.clipboard`，本轮
  只验证了应用设计的手动抄写回退，系统剪贴板写入随后由原生插件轮补验（见下）。
- 设备阶段由 `Global\PTCGMobileDeviceValidation` 全局互斥锁持有后执行；结束后
  复验互斥锁已释放、8798 服务已停止、本票的 adb forward/reverse 已清理。

剪贴板原生插件复验（同日，源码提交 7749072，APK SHA-256
`55A8C48A3A7DF75C0363A799BE56AA76D637D1FA6B9D9AB311CD3B0C379CEC71`，与本地
`app-debug.apk` 一致；设备阶段记录 `source tree dirty lines = 0`）：

- 客户端新增剪贴板抽象：原生 Android 走官方 `@capacitor/clipboard` 8.0.1
  （匹配 Capacitor 8.5.2 主版本，`cap sync` 注册 `:capacitor-clipboard`），
  浏览器保留 `navigator.clipboard`；原生失败再退回 Web API 一次，两者都失败
  才显示带正确房间码的手动抄写提示。抽象路径（原生优先、浏览器路径、原生失败
  回退、双失败）与界面成功/失败反馈都有单元测试。
- 本轮仍用 ADB 真实物理点击复制按钮（同一坐标换算路径，实测屏幕点
  `(1459, 617)`、`dpr=2.25`、窗口 `0,0,2560,1440`），界面显示“已复制房间码”；
  随后在应用自己的 WebView 里通过 `window.Capacitor.Plugins.Clipboard.read()`
  读回系统剪贴板，得到 `{"value":"357184","type":"text/plain"}`，与界面显示的
  房间码逐字符相等；未启动或触碰任何其他应用。
- 房间全链路（建房 → 主机进程第二客户端加入/选卡组/准备 → 设备选卡组/准备 →
  唯一会话 v1 → 返回 UI 重入 → 切回发行目录后准备被拒）在修复后重跑通过；
  隐私检查仍无身份私钥与原生桥插件载荷。设备阶段仍由全局互斥锁持有，结束后
  互斥锁、8798 端口与本票 forward/reverse 均已复验清理。

跨房间缓存重放修复与合并 #16 后的组合验收（同日，源码提交 bcb2901，APK SHA-256
`1FCB62D49B35BD035C1B52C90D57F7E67E6EE17EE9261CC6787CAA7FE51EDC545`，与本地
`app-debug.apk` 一致；设备阶段记录 `source tree dirty lines = 0`）：

- 修复：服务端按设备保留命令结果，离开/重入与房间码复用后旧命令的缓存快照或
  缓存错误可能晚到。建房/加入/选卡组/准备/离开的直接结果与错误现在携带原始
  `commandId`；客户端只采纳与当前等待命令匹配的直接结果，并以 `(roomId, version)`
  与离开实例墓碑丢弃无命令关联的旧快照。真实服务端到端测试重放 A 的旧选卡组
  快照与旧 `version-conflict` 缓存错误，界面保持在新房间 B；控制器级测试覆盖
  等待窗口、墓碑、显式重入与相同版本一致性。
- 合并 `454d5a4`（#16 卡图缓存/文件系统）后保留双方功能：Android 同时注册
  `:capacitor-clipboard` 与 `:capacitor-filesystem` 插件，房间/卡组/缓存界面与
  协议并行保留；合并后 112/58/161 项测试、typecheck、目录与资源包检查、
  握手与房间端到端、正式构建与发行包检查全部通过。
- 设备组合冒烟（同一 MuMu 实例，APK 哈希与本地一致）：`pm clear` 后设置页显示
  图片缓存入口与占用；真实 ADB 点击复制按钮后原生插件读回
  `{"value":"888810","type":"text/plain"}` 与房间码逐字符相等；房间全链路
  （建房 → 主机进程第二客户端加入/准备 → 设备选卡组/准备 → 唯一会话
  `af0ecb8a…` v1 → 返回 UI 重入 → 发行目录拒绝准备）通过；隐私日志 0 命中；
  进程重启后 #16 图片缓存入口与 #6 真实草稿（仙子伊布VMAX 和弦进化）都保留。
- 设备阶段仍由全局互斥锁持有；结束后复验互斥锁已释放、8798 服务与 19328 CDP
  转发/reverse 已清理、5037 与 MuMu 实例未受影响。

匹配结果生命周期修复与复验（同日，源码提交 ba8de01，APK SHA-256
`0728315418AD88A06117A267CD4B211AFDA48C3F31F69FF2166E6A7C2CF9A6CA`，与本地
`app-debug.apk` 一致；设备阶段记录 `source tree dirty lines = 0`）：

- 修复：无命令关联的对手房间广播只更新房间内容与版本，不再结束本机等待，也
  不重置错误生命周期；只有携带匹配 `commandId` 的直接结果才结束等待。乱序时
  匹配结果若比先到的广播旧，保留更新版本的房间内容并结束等待，避免 pending
  卡死或自己的 `version-conflict` 被当作旧回包丢弃。控制器新增三条回归（对手
  广播先到后的冲突错误与成功结果、等待加入时的同实例广播），界面测试的选卡组/
  准备结果改为携带 `commandId`。全量 112/58/164 项测试、typecheck 与 15 项房间
  端到端通过。
- 设备复验（同一 MuMu 实例，APK 哈希与本地一致）：真实 ADB 点击复制按钮后原生
  插件读回 `{"value":"532627","type":"text/plain"}` 与房间码逐字符相等；房间
  全链路（建房 → 主机进程第二客户端加入/准备 → 设备选卡组/准备 → 唯一会话
  `fae27c47…` v1 → 返回 UI 重入 → 发行目录拒绝准备）通过；隐私日志 0 命中；
  进程重启后 #16 图片缓存入口与 #6 真实草稿都保留。
- 设备阶段仍由全局互斥锁持有；结束后复验互斥锁已释放、8798 服务与 19328 CDP
  转发/reverse 已清理、5037 与 MuMu 实例未受影响。

证据保存在本机忽略目录 `.toolchain/issue7-run/device/`（当前为 ba8de01 轮的
`acceptance.log`、`results.json`、`01`–`08` 各阶段截图、拉取的 APK、夹具目录、
各轮服务日志与复验证据等；bcb2901 轮证据归档在同级
`.toolchain/issue7-run/device-bcb2901/`），由
`.toolchain/issue7-run/device/device-room-acceptance.mjs` 可重复执行；设备阶段
使用已随 #16 合并入仓库的 `tools/device-validation/invoke-with-device-mutex.ps1`
持有跨代理 `Global\PTCGMobileDeviceValidation` 命名互斥锁，锁被占用时不触碰设备。

**T06 仍未完成**（不得以模拟器结论代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 对局内的先后攻选择、初始场面、重抽与完整规则结算属于 #8 起；本票只交付到
  “唯一对局会话 + 初始版本 + 已固定卡组”。

## 真实开局、双方重抽与初始场面（T07 / #8）

对局协议在 `packages/protocol/src/match.ts`，服务端开局引擎与会话在
`packages/service/src/match.ts`，客户端状态机与界面在
`packages/client/src/rooms/matchController.ts` 与 `packages/client/src/ui/MatchScreen.tsx`。
房间双方准备后只建立一次会话（`sessionId`），随后对局按冻结官方证据依次推进：

1. **先后攻**：服务端用 `crypto.randomInt` 随机决定谁获得选择权；只有获选座位
   收到 `turn-order` 待决选择并能选择先攻/后攻。
2. **洗牌与手牌**：双方各洗牌并抽 7 张。无「基础」宝可梦时严格按 G5：
   只有一方没有时，对手先完成到 7.（战斗/备战盖放与奖赏卡）之后，才展示
   该方整副手牌并只重洗该方（5.c.–5.d.，第 2 次起跳过 5.b.）；双方都没有
   时互相展示后共同重洗重抽（5.a.），共同重洗不执行 5.d.，公开记录以
   `shared` 区分。
3. **初始盖放**：双方按先攻→后攻顺序选择 1 张基础宝可梦作为战斗宝可梦，
   可选至多 5 张基础宝可梦盖放到备战区；公开翻面前对手载荷里没有这些身份。
4. **奖赏卡与补抽**：双方各从牌库顶取 6 张盖放；随后按座位结算补抽，
   上限只等于对手执行 5.d.（单独重抽）的次数，共同重洗（5.a.）不计入——
   公开的 `mulligans` 总次数与 `soloMulligans` 单独重抽次数在载荷中分离。
5. **最终备战**：G6 允许在对战开始前把当前手牌中剩余的基础宝可梦盖放到
   备战区，包括补抽得到的与零补抽的情况；备战上限 5、战斗宝可梦不变。
6. **公开翻面与首回合**：双方场上宝可梦一起公开，只进入一次 `turn = 1`，
   首回合玩家按规则先抽 1 张。

上述顺序来自官方《进阶玩家向规则指南》Ver 3.1.0 G「对战准备」原文
（G5.a. 共同重洗、G5.b.–d. 单方展示/重洗、G6 备战、G7 奖赏卡与按对手
5.d. 次数的可选补抽）。单方重抽时对手的奖赏卡在展示前完成，但补抽张数在
全部 5.d. 结束后结算，从而既保护对手尚未提交的初始选择，又不漏计当次重抽；
实现与测试不引用探针实现作为规则来源。

每条对局命令携带 `sessionId`、`expectedVersion` 与 `choiceId`：越权、非法
数量、旧 `choiceId`、重复命令与命令 ID 复用都不会改变状态；同一命令 ID 的
精确重传返回第一次结果（`duplicate`）。协议解析器严格拒绝未知字段，发行
客户端无法夹带 `seed`、`deckOrder` 或修改服务端随机。测试确定性只通过
服务端内部随机源注入（`ServiceRoomOptions.matchRandom`），不是客户端输入。

```bash
npm test -w @ptcg/protocol   # match.test.ts：命令/视图解析、隐藏身份载荷被拒绝、seed/deckOrder 被拒绝
npm test -w @ptcg/service    # matchEngine.test.ts / matchFlow.integration.test.ts：规则分支、认证去重、双客户端隐私
npm test -w @ptcg/client     # matchController.test.ts / matchFlow.test.tsx：等待/选择流程与界面隔离
npm run test:e2e:opening     # 真实服务 + 两客户端 + 真实随机：19 项通过
```

### 开局设备验收现状（2026-09-20，T07 修复轮）

复审修复（源码提交 `6745a7b`）后重新在 MuMu Player 12（Android 12 / SDK 32）
`127.0.0.1:16384` 上用同一套 ADB + WebView CDP 完成真实 APK 流程，安装包
SHA-256 `87D23E5ABC7F8313AE359F11E1FC08CC28F01F9BFE05ACE178BCBFA464C2F1C9`
（9 980 296 字节）与本地 `app-debug.apk` 一致；设备驱动记录
`source commit = 6745a7b…`、`source tree dirty lines = 0`。设备端是一个真实
APK 客户端，第二客户端是主机 Node 进程（使用构建后的协议包），服务端为
构建后的真实服务进程；服务回环端口 8799、CDP 回环端口 19329。上一轮
（提交 `0b6f797`、APK `A969502F…`）证据归档在 `device-attempt1/`，本节新
证据取代它作为当前实现结论。

- **复审五类修复的红/绿**：新规则测试先在修复前实现上失败（协议 3 项、服务
  12 项、客户端 5 项），修复后全量 122/86/176 项与类型检查通过；见忽略目录
  `.toolchain/issue8-run/repair-red.log` 与 `repair-green-tests.log`。
- **真实开局主链路**：双方准备后设备自动进入「开局准备」。设备用真实点击
  完成获选方的先攻选择、初始盖放（含 5.b. 次序下对手先到 7.）、对手单独
  重抽后的可选补抽与最终备战（`place-bench`，界面为
  `match-bench-form`/`match-confirm-bench`）。随后公开翻面，设备显示
  「第 1 回合 · 轮到小智（你）」、双方奖赏卡各 6 张，公开记录含
  「第 1 回合开始：轮到小智」；主机客户端看到同一 `sessionId`、`turn = 1`
  且只有一条 `turn-started`。驱动记录
  `deviceChoice=true deviceSetup=true deviceComp=true deviceCompBench=true`。
- **等待与选择提示**：另一方获选时，设备显示「等待{对手}选择先后攻…」；
  对手盖放后显示「初始宝可梦已盖放（未公开）」，不渲染身份。
- **隐私（载荷）**：主机进程客户端收到的每一条原始载荷都通过协议严格解析；
  对手手牌始终只有张数，公开翻面前对手战斗/备战没有身份；未公开的设备卡
  身份从未出现在对手载荷；没有 `deckOrder` 或内部实例 ID。
- **隐私（界面）**：公开翻面前设备 DOM 不包含对手盖放卡的名称（规则要求的
  重抽公开展示除外）。
- **不认输**：首回合后点「返回首页（不认输）」保留同一会话，主机侧看到会话
  不变。
- **身份日志**：按 app PID + 新鲜时间戳过滤的 logcat 中身份私钥标量、
  `privateKey` 与 Capacitor 插件载荷命中均为 0（`loggingBehavior: none`）。
- **发行隔离**：服务使用从发行目录派生的「效果已接入」测试夹具；发行目录
  本身仍全部「效果未接入」，设备选卡组只在夹具下判为可正式对战，夹具不进入
  仓库、APK 或发行目录。

证据保存在本机忽略目录 `.toolchain/issue8-run/device/`（本轮
`run-repair-attempt1.log`、`apk-build-repair*.log`、`acceptance.log`、
`results.json`、`01-settings`/`02-room-created`/`03-opening-screen`/
`04-opponent-face-down`/`05-first-turn` 截图、`fixture-catalog.json`、服务日志、
拉取的 APK 等），不随仓库提交；驱动为
`.toolchain/issue8-run/device/device-opening-acceptance.mjs`，设备阶段由
`tools/device-validation/invoke-with-device-mutex.ps1` 持有
`Global\PTCGMobileDeviceValidation` 全局互斥锁，结束后复验互斥锁已释放、
本票服务停止、本票 `adb reverse/forward` 已清理，不停止 5037 与 MuMu 实例。

**T07 仍未完成**（不得以模拟器结论代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 首回合之后的出牌、附能、进化、训练家与完整胜负结算属于 #9 起；本票只交付
  到「双方初始准备完成且只进入一次首回合」，界面明确说明后续版本才提供
  回合内操作。
- 开局设备验收只覆盖一轮随机分支；重抽/双方同时重抽/补抽 0 张与上限/非法
  初始卡/旧选择 ID 等分支由服务与客户端自动化测试覆盖（见上文命令）。

**仍未完成**（不得以模拟器结论代替）：

- 真机验收：父规格要求至少一台真实 Android 设备，上述结论（包括软键盘像素级
  遮挡验收）全部来自模拟器。
- 短边 360 dp / 4 GiB 设备、完整对战与发布级双客户端验收属于后续发布验收，
  不在本票范围。

## 真实交替回合、附能与招式结算（T08 / #9）

回合内核在 `packages/service/src/match.ts`（`MatchEngine`）中实现，协议与客户端
分别在 `packages/protocol/src/match.ts`、`packages/client/src/rooms/matchController.ts`
与 `packages/client/src/ui/MatchScreen.tsx`。回合规则按冻结证据执行：

1. **回合开始**：当前回合玩家必须从牌库顶抽 1 张；牌库为空时无法抽卡，只标记
   `cannotDraw`，不伪造胜负（完整败北判定属 #10）。
2. **基础宝可梦**：手牌中的「基础」宝可梦可进备战区，一回合任意只、上限 5
   （进阶指南 A-04）。
3. **附能**：每个自己的回合从手牌至多附着 1 张基本能量；特殊能量在效果接入前以
   `unsupported-card` 拒绝；非法目标不消耗本回合次数。
4. **撤退**：每回合 1 次；支付恰好等于撤退费用的所选能量（数量、序号、重复都
   校验），与 1 只备战宝可梦交换；备战区为空、睡眠/麻痹或“无法撤退”效果禁止撤退；
   失败不扣能量也不消耗次数。撤退清除特殊状态与效果标记（检查/恢复时机属 #10）。
5. **招式**：只能由当前回合玩家使用；先攻玩家最初回合禁止使用招式
   （basic_rules05 3.b.）；同属性费用必须由对应属性能量满足、无色费用任意能量均可；
   使用招式结算后回合结束。伤害按「基础伤害 → 弱点（倍增）→ 抵抗（减少）」计算，
   0 或负数不放置伤害指示物。未注册说明文的招式以 `unsupported-card` 拒绝，不做近似。
6. **伤害与伤害指示物**：`attack-used` 记录基础/最终伤害，`damage-counters-placed`
   记录实际放置的指示物；会话级 `attackEffects` 接口区分 `dealDamage()`（走弱点/抵抗）
   与 `placeDamageCounters()`（直接放置），供后续逐卡接入使用。

命令与错误：`play-basic` / `attach-energy` / `retreat` / `attack` / `end-turn` 携带
`sessionId`、`expectedVersion`；新增 `not-your-turn`、`action-not-allowed`、
`illegal-target`、`illegal-cost`、`insufficient-energy`、`unsupported-card`。服务端
按座位认证、命令 ID 去重与版本串行裁决；重复命令只生效一次，旧版本/乱序返回
`stale-version` 并同步当前投影，非法操作不改变状态。公开记录与两个客户端的可见
状态一致；对手手牌、牌库顺序与奖赏身份仍只以张数或本人视图投影。

```bash
npm test -w @ptcg/protocol   # match.test.ts：回合命令/事件解析与隐藏信息边界
npm test -w @ptcg/service    # matchTurns.test.ts / matchTurnFlow.integration.test.ts：回合规则、效果例外接口、双客户端网络
npm test -w @ptcg/client     # matchController.test.ts / matchFlow.test.tsx：回合命令与操作界面
npm run test:e2e:turn        # 真实服务 + 两客户端：开局后双方各完成真实回合与招式伤害
```

### 回合设备验收现状（2026-09-20，T08）

在 MuMu Player 12（Android 12 / SDK 32）`127.0.0.1:16384` 上用 ADB + WebView CDP
完成真实 APK 流程，安装包 SHA-256
`7B19169FEFC40A3C87C95751C6743B83AB33F3DCC16B5E1B4F08705678CEE65B`（10 118 505 字节）
与本地 `app-debug.apk` 一致；设备驱动记录 `source commit = bc5fbb2…`、
`source tree dirty lines = 0`。设备端是真实 APK 客户端，第二客户端是主机 Node
进程，服务端为构建后的真实服务进程（回环端口 8800、CDP 回环端口 19330）：

- 双方准备后设备自动进入对局；设备用真实触控完成先后攻/盖放/补抽分支，并在
  回合内完成「放置基础宝可梦到备战区、选择手牌能量并附着到战斗宝可梦、结束
  回合」；主机客户端完成后攻回合的附能与「水枪」招式。
- 双方各完成至少一个真实回合（本轮至少推进到第 3 回合）：回合开始抽牌、附能、
  招式/结束回合与公开伤害指示物在两个客户端一致；公开记录区分基础伤害与最终
  伤害、伤害与伤害指示物。
- 隐私：主机侧原始载荷全部通过协议严格解析；对手隐藏区只有张数，洗牌后未公开
  身份不进入载荷；设备 DOM 在公开翻面前不渲染对手盖放身份。
- 身份日志：按 app PID + 新鲜时间戳过滤的 logcat 中身份私钥标量、`privateKey`
  与 Capacitor 插件载荷命中均为 0。
- 发行隔离：服务使用从发行目录派生的「效果已接入」测试夹具；发行目录仍全部
  「效果未接入」，回合端到端脚本另起发行目录服务确认准备被拒绝。

证据保存在本机忽略目录 `.toolchain/issue9-run/device/`（`acceptance.log`、
`results.json`（11 项通过）、`01-settings`…`06-turn-walkthrough` 截图、
`fixture-catalog.json`、服务日志与拉取的 APK），不随仓库提交；驱动为
`.toolchain/issue9-run/device/device-turn-acceptance.mjs`，设备阶段由
`tools/device-validation/invoke-with-device-mutex.ps1` 持有
`Global\PTCGMobileDeviceValidation` 全局互斥锁，结束后复验互斥锁已释放、本票服务
停止、本票 `adb reverse/forward` 已清理，不停止 5037 与 MuMu 实例。

**T08 仍未完成**（不得以模拟器结论代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 昏厥、奖赏、特殊状态、完整胜负、进化、特性、训练家卡与附加卡属于 #10–#12；
  未接入的卡牌效果在正式对局中维持 `unsupported-card`。
- 牌库耗尽只在回合开始如实标记无法抽卡；败北/平局判定由 #10 完成，本票不伪造胜负。

## 结算：特殊状态、昏厥、奖赏与完整胜负（T09 / #10）

结算内核在 `packages/service/src/match.ts`（`MatchEngine`），协议在
`packages/protocol/src/match.ts`，客户端状态机与界面在
`packages/client/src/rooms/matchController.ts`、`packages/client/src/rooms/roomController.ts`
与 `packages/client/src/ui/MatchScreen.tsx`。规则全部依据冻结的官方《进阶玩家向规则指南》
Ver 3.1.0（D 昏厥 / E 胜负 / F 宝可梦检查）与 basic_rules07 正文：

1. **特殊状态**：中毒每次宝可梦检查放 1 个指示物；灼伤放 2 个后由持有者抛硬币
   （正面恢复、反面继续）；睡眠由持有者抛硬币（正面恢复）；麻痹在自己下一个回合
   结束后的宝可梦检查恢复。中毒/灼伤可与任意状态叠加；睡眠/麻痹/混乱三者互斥，
   新状态替换旧状态。混乱不在宝可梦检查中处理：攻击宣言后抛硬币，反面招式失败、
   自身放置 3 个伤害指示物并结束回合；混乱不影响撤退。睡眠/麻痹禁止招式与撤退。
2. **宝可梦检查**：每个玩家回合结束（含招式结束的回合）按【中毒】【灼伤】【睡眠】
   【麻痹】顺序对双方战斗宝可梦确认，检查末尾确认没有剩余 HP 的宝可梦昏厥。
3. **昏厥与奖赏**：昏厥宝可梦与所有附着卡（能量/道具）一同进入弃牌区；双方拿取
   与对手昏厥宝可梦卡面奖赏价值相同张数的奖赏卡（`specialRuleTextZh` 写明 ex/V/
   VSTAR=2、VMAX=3，其余 1）；张数超过剩余奖赏时取完剩余张数。取奖赏与补充
   战斗宝可梦的待决选择属于规则指定的玩家；奖赏身份在规则公开前不进入载荷、
   公开记录或对手视图，取走后才进入本人手牌。
4. **强制补充与同时昏厥**：战斗宝可梦昏厥且有后备时必须选择 1 只升前；双方战斗
   宝可梦同时昏厥时由下一回合轮到的玩家先放战斗宝可梦；没有后备可补时该方败北。
5. **胜负**：三项败北条件（对手拿取全部奖赏卡 / 自己场上没有宝可梦 /
   自己回合最初无法抽牌）在相关处理进行到底后判定；同时满足胜负条件时按冻结判定表
   逐项计票（票多者胜、相等为平局，含 5 种平局组合），不使用 first-match。
   抢分赛在 Ver 3.1.0 中是“实在想分出胜负时”的可选流程，引擎不强制开始；平局后
   返回原房间重新准备即可按新局继续。一般效果抽空不判败，只有回合最初无法抽牌
   才判回合开始抽空败北。
6. **认输与终态**：`concede` 任意对局阶段可用；权威终态只生成一次并拒绝其后任何
   操作（`match-finished`）；双方看到同一结果。房间在对局终态后进入 `finished`：
   保留原房间实例与旧会话供重入查看，撤销双方准备；双方重新准备后在同一房间
   创建新会话（新一局）。
7. **公开事件**：`status-inflicted`、`status-recovered`、`checkup-flip`、
   `confusion-flip`、`pokemon-knocked-out`、`prizes-taken`（只有张数）、
   `replacement-placed`、`conceded`、`match-finished` 解释伤害/状态/昏厥/结果；
   隐藏区域仍只以张数或本人视图投影。

```bash
npm test -w @ptcg/protocol   # match.test.ts / room.test.ts：新命令、状态/终态视图、事件解析与隐私边界
npm test -w @ptcg/service    # matchSettlement.test.ts（25 项规则分支，含混乱硬币原子性）/ matchSettlementRoom.integration.test.ts（终局后原房重新开局与换人隐私）
npm test -w @ptcg/client     # matchController.test.ts / matchFlow.test.tsx / roomController.test.ts：结算选择、终态界面与重新准备
npm run test:e2e:settlement  # 真实服务 + 两客户端：真实 KO → 取奖赏 → 无后备终态 → 原房重新开局 → 终局后换人隐私（28 项）
```

### 结算设备验收现状（2026-09-20，T09）

在 MuMu Player 12（Android 12 / SDK 32）`127.0.0.1:16384` 上用 ADB + WebView CDP
完成真实 APK 流程，安装包 SHA-256
`3DD0D52FA5B91B4A60B313034A67E78B3BE22173C1AF2B7633D5838024D3FA0D`（10 123 462 字节）
与本地 `app-debug.apk` 一致；设备驱动记录 `source commit = 2accfce…`、
`source tree dirty lines = 0`。设备端是真实 APK 客户端，第二客户端是主机 Node
进程，服务端为构建后的真实服务进程（回环端口 8801、CDP 回环端口 19331，
夹具目录 `fe9788b47401…`）：

- 双方准备后设备自动进入对局；设备真实触控完成先后攻/盖放/补抽分支。主机客户端
  使用夹具攻击手（1 水能量 990 伤害）在真实回合昏厥设备战斗宝可梦；设备端
  真实界面完成取奖赏前的等待与结果展示。
- 终态：设备战斗宝可梦昏厥（含其附着卡进弃牌区）→ 取奖赏卡（只公开张数，
  身份不进载荷/公开记录）→ 设备无后备可补 → `winner=主机座位, reason=no-pokemon`；
  双方客户端与设备 DOM 显示同一结果（`06-settlement-result`），公开记录包含
  昏厥、拿取奖赏与对局结束说明。
- 终态后设备/主机继续出牌被 `match-finished` 拒绝，`match-finished` 只出现一次；
  设备点击「返回房间」后房间进入 `finished`（保留旧会话、双方准备撤销）。
- 双方重新准备后在同一房间实例创建新会话（`oldSession != newSession`），设备自动
  回到新对局（`07-rematch`）；服务端记录两次 `room.match_created`、一次
  `room.match_finished`；终态后返回首页/重入房间仍保留新会话。
- 隐私：主机侧每条原始载荷通过协议严格解析；对手隐藏区只有张数，未公开的设备卡
  身份不进入载荷或 DOM；奖赏事件不含身份字段。
- 身份日志：按 app PID + 新鲜时间戳过滤的 logcat 中身份私钥标量、`privateKey`
  与 Capacitor 插件载荷命中均为 0。
- 发行隔离：服务使用从发行目录派生的「效果已接入＋E2E 夹具」测试目录；发行目录仍
  全部「效果未接入」，另行确认准备被拒绝。

证据保存在本机忽略目录 `.toolchain/issue10-run/device/`（`acceptance.log`、
`results.json`（14 项通过）、`01-settings`…`07-rematch` 截图、`fixture-catalog.json`、
服务日志与拉取的 APK），不随仓库提交；驱动为
`.toolchain/issue10-run/device/device-settlement-acceptance.mjs`，设备阶段由
`tools/device-validation/invoke-with-device-mutex.ps1` 持有
`Global\PTCGMobileDeviceValidation` 全局互斥锁，结束后复验互斥锁已释放、本票服务
停止、本票 `adb reverse/forward` 已清理（`forward/reverse` 列表为空），不停止 5037
与 MuMu 实例。

#### 结算复审修复轮（2026-09-20，T09 P1/P2）

两次独立复审在验收前阻断了两类问题，已修复并补上回归：

- **P1 隐私**：终局后来宾离开释放座位时旧 `match` 仍保留，新设备加入同一座位后
  的加入/重入/重复建房路径会把按旧座位投影的 `MatchView`（含原玩家手牌、奖赏与
  事件）发给新设备，旧会话命令也会命中旧座位的对局句柄。修复：`rooms.ts` 把对局
  参与者按创建会话时的设备身份授权；`sendMatchView` 只发给 `room.match.seats[seat]`
  与当前座位设备一致的两个参与者；对局命令先校验参与者身份，再判定连接接管，
  换人后的新设备与旧连接都得到 `not-in-match` 且不带任何私人视图。原座位仍能查看
  同一终态，并在同一房间实例与新座位重新准备开局。
- **P2 原子性**：混乱招式先抛硬币、写 `confusion-flip` 事件，之后才执行效果回调；
  回调登记失败时版本未递增，但随机已被消耗、事件已追加（同一命令重试会重掷或
  跳过硬币）。修复：`match.ts` 把效果接口登记与基础伤害校验全部提前到硬币之前，
  任何登记失败都发生在随机、事件与状态变化之前；反面丢弃已登记的暂存效果、自伤
  3 个指示物并结束回合，正面效果恰好应用一次，重试按原随机序列消耗一次硬币。

回归测试：`matchSettlement.test.ts` 新增 3 项（非法登记不消耗随机/不追加事件/双方
视图与版本不变、登记失败重试按原序列抛出反面、正面应用一次与反面丢弃暂存），
`matchSettlementRoom.integration.test.ts` 新增 1 项（终局后换人：加入/重入/重复
建房/旧会话命令/连接接管/原座位终态/新会话开局）。本轮全量 `npm test` 470 项
（130/148/192）与 `npm run typecheck` 通过；`npm run test:e2e:settlement` 由 24 项
扩到 28 项（新增换人隐私 4 项）；其余端到端 18/15/19/28 项通过。

设备复验（同一 MuMu Player 12 实例，回环端口 8801、CDP 回环 19331，夹具目录
`fe9788b47401…`）：源码提交 `0318493`、`source tree dirty lines = 0`，14 项全部
通过（KO → 取奖赏 → 无后备终态 → 原房重新准备 → 新会话），与上一轮相同的
APK SHA-256 `3DD0D52FA5B91B4A60B313034A67E78B3BE22173C1AF2B7633D5838024D3FA0D`
（10 123 462 字节）在设备上安装并核对一致。客户端代码自 `2accfce` 起未变，重建
后 APK 字节与上一轮一致；变化的是服务端修复与测试，设备驱动记录的新源码提交为
`0318493`。结束后复验互斥锁已释放、本票服务已停止、本票 `forward/reverse` 列表
为空，不停止 5037 与 MuMu 实例。

**T09 仍未完成**（不得以模拟器结论代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 抢分赛只按 Ver 3.1.0 的可选流程说明处理（平局为默认裁定，重新准备即可开新局）；
  引擎不提供自动加赛模式。
- 由卡牌触发的额外奖赏例外、特性/训练家卡/附加卡效果与进化仍属 #11/#12；未接入的
  卡牌效果在正式对局中维持 `unsupported-card`。

## 断线与 Android 进程终止恢复（T14 / #15）

实现提交为 `78a8f4c`，复审修复提交为 `2022961`，半开连接活性修复提交为
`134496e`：服务端按冻结设备身份确认座位、新连接接管并撤销旧连接操作权（不能
仅凭昵称/房间码接管）；断线进入等待并按每人每局 180 秒服务端预算累计，重连不
重置、只在真正创建新对局时重置；离线期间拒绝对局命令并保留待决选择；显式
离开与传输断开共用同一预算记账；服务重启把未结束对局标为服务中断无胜负并可
重新开局；被接管连接停止自动重连。协议、服务与客户端共用同一恢复路径，恢复
不区分具体卡牌效果。

半开连接（对端断网/掉电但服务端收不到 FIN/RST）由服务端 WebSocket 心跳
看门狗处理：每 `intervalMs=10s` 发一次协议层 ping，`pongTimeoutMs=10s` 内没有
pong 即判定无响应，先走既有幂等 `detachConnection` 登记离线（预算从此刻开始），
再强制销毁该陈旧套接字。检测上界为 `intervalMs + pongTimeoutMs = 20s`，因此真实
断网时长中最多 20 秒不计入 180 秒预算。浏览器 WebView 与 `ws` 客户端都会自动
回 pong，客户端业务代码无需改动；被新连接取代的旧连接即使之后超时，也只能命中
幂等 detach，不会把座位上的新连接判离线。

管理器复跑全量 `npm test` 510 项（协议 132 / 服务 169 / 客户端 209）与
recovery 端到端 33 项通过，`typecheck`/`build` 通过；服务端新增 5 项看门狗受控
时钟测试与 3 项真实套接字集成测试（无 close/无 pong 半开连接、健康空闲多周期、
连接替换竞态），注册表级接管测试补充“旧连接迟到 detach 幂等无操作”断言。

### 设备验收 A：应用级断线 + 进程终止（2026-09-20，MuMu Player 12 实例 0）

驱动 `device-recovery-acceptance.mjs`（所有 ADB/CDP 调用有超时、5 分钟看门狗、
增量写证据、finally 有界清理）。源码提交 `2022961`、`source tree dirty lines = 0`；
APK SHA-256 `6D89617A11E461430461F2B8AA41301B2C510143BE09F995BDADB6BF3CAB05F8`
（10 132 307 字节）与设备安装包核对一致，22/22 项通过：应用级网络离线 +
套接字断开进入等待重连（标签如实注明为 CDP WebView 网络仿真 + 应用内 socket
close，**不是**物理网络设置切换）、切后台再回前台、`am force-stop` 冷启动恢复
同一对局待决选择、身份/昵称/地址/草稿/目录缓存持久化哈希不变、服务重启服务中断
与重新开局入口可直接建房、设备载荷无对手手牌身份与 `instanceId`/`deckOrder`、
logcat 无身份私钥/Capacitor 插件载荷。证据：`.toolchain/issue15-run/device/`
（`acceptance.log`、`results.json`、`01`–`10` 截图、`device-socket-events.json`、
`device-ws-frames.json`、`logcat-privacy.txt`）。

### 设备验收 B：真实 Android WiFi 传输关闭/恢复（2026-09-20，MuMu Player 12 实例 0）

只读排查确认该实例唯一可用传输是虚拟 WiFi `wlan0`（`10.0.2.15/24`，默认路由
`10.0.2.2`），`com.android.shell` 已授予 `NETWORK_SETTINGS`/`CHANGE_WIFI_STATE`，
因此 `cmd wifi set-wifi-enabled disabled/enabled` 是只影响该验证实例、可逆的真实
设备级网络变化。驱动 `device-network-switch-acceptance.mjs` 预置设备内 `setsid`
定时恢复并在 finally 再次恢复；应用把服务地址临时指向真实 WiFi 路径
`ws://10.0.2.2:8803/ws`（非 ADB reverse），结束时持久化地址恢复为验证前的
`http://127.0.0.1:8802`、恢复记录恢复为 null，WiFi 已连接，adb forward/reverse
只清理本票 `19333/8803`。源码提交 `134496e`、`dirty = 0`。

结果 20 项全部通过。切换在 `13:26:20Z` 执行，服务端在 `+16.8s`（检测延迟
`16790ms`，≤ 心跳上界 `20000ms` + 调度余量）由心跳看门狗判定设备离线并记录
`room.disconnected`（同刻 `connection.liveness_timeout`），对手主机客户端视图
在丢失窗口内变为 `opponentOnline=false`；关闭窗口内 adb/CDP 传输与应用连接
同时不可达（`ETIMEDOUT`），设备侧无法再探针；预置的设备内定时恢复在约 45 秒时
重新开启 WiFi，脚本测得关闭窗口 `53.1` 秒（含 adb 传输恢复等待）后 WiFi 已
连接。设备以新连接重入原座位（服务端 `room.rejoined` 一次），同一身份
（`dev_F1yj7MEQbhp10Xx3A4Vtqx`）、同一会话
`e0baa3d9-6c7c-422c-b71a-b8050118f8b5`、同一待决选择；恢复后读到
`disconnectBudgetMs=180000` 与累计 `yourDisconnectMs=28605`，与
`rejoinAt - detectionAt = 28545ms` 一致（Δ60ms），即预算从判定时刻开始、
检测延迟不计入；载荷隐私与 logcat 隐私保持。
证据：`.toolchain/issue15-run/device/network-switch-{log,results.json,state.json,ws-frames.json,socket-events.json}`、
`nsw-01`–`nsw-04`、`nsw-06`–`nsw-07` 截图、`nsw-logcat-privacy.txt`、
`nsw-service-8803-*.log`。

本轮修复闭合上一轮确认为 TCP 半开连接的差距：丢失窗口内服务端以心跳自动判
离线并开始 180 秒预算，全过程不依赖对端 close、玩家操作或前端上报；验收驱动
只使用设备内 `setsid` 定时恢复 WiFi，主机对手客户端的丢失窗口探针改为异步
ADB 调用，避免测试进程自身阻塞掩盖真实断线语义。

**仍未完成**：父规格要求的物理 Android 设备验收；本轮全部结论来自模拟器实例 0。
