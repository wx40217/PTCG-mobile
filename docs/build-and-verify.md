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
npm test                    # 全部单元与集成测试（协议 107 项 / 服务 55 项 / 客户端 108 项）
npm run typecheck           # 三个包的类型检查
npm run test:e2e            # 端到端验收：真实服务进程 + 客户端连接代码（含断线/主动断开）
npm run test:e2e:rooms      # 房间端到端：真实服务 + 两客户端建房/加入/准备/唯一会话/第三人拒绝/房主离开
npm run check:release-bundle # 正式产物中不得出现明文地址或回环地址
npm run service:start       # 启动服务（默认 127.0.0.1:8787）
node tools/card-data/build-card-data.mjs                 # T01 卡牌资料校验
node --test tools/card-catalog/build-catalog.test.mjs    # T04 目录产物校验与构建测试
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
npm test -w @ptcg/client     # roomFlow.test.tsx：建房/加入/选卡组/准备/开局/复制房间码
npm run test:e2e:rooms       # 真实服务进程端到端（含第三人拒绝与房主离开）
```

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

证据保存在本机忽略目录 `.toolchain/issue7-run/device/`（`acceptance.log`、
`results.json`、`01`–`07` 各阶段截图、拉取的 APK、夹具目录、各轮服务日志与
复验证据等），由 `.toolchain/issue7-run/device/device-room-acceptance.mjs`
可重复执行；设备阶段由从 `#16` 工具目录复制并经本票确认的
`invoke-with-device-mutex.ps1` 持有跨代理 `Global\PTCGMobileDeviceValidation`
命名互斥锁，锁被占用时不触碰设备。

**T06 仍未完成**（不得以模拟器结论代替）：

- 真机 Android 设备验收仍是父规格要求，本轮结论全部来自模拟器。
- 对局内的先后攻选择、初始场面、重抽与完整规则结算属于 #8 起；本票只交付到
  “唯一对局会话 + 初始版本 + 已固定卡组”。

**仍未完成**（不得以模拟器结论代替）：

- 真机验收：父规格要求至少一台真实 Android 设备，上述结论（包括软键盘像素级
  遮挡验收）全部来自模拟器。
- 短边 360 dp / 4 GiB 设备、完整对战与发布级双客户端验收属于后续发布验收，
  不在本票范围。
