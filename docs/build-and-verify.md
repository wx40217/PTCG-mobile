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
| Capacitor（core/cli/android） | 8.5.2 | 安卓外壳；`@capacitor/app` 8.1.1、`@capacitor/preferences` 8.0.1 |
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
npm test                    # 全部单元与集成测试（协议 93 项 / 服务 34 项 / 客户端 99 项）
npm run typecheck           # 三个包的类型检查
npm run test:e2e            # 端到端验收：真实服务进程 + 客户端连接代码（含断线/主动断开）
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

**仍未完成**（不得以模拟器结论代替）：

- 真机验收：父规格要求至少一台真实 Android 设备，上述结论（包括软键盘像素级
  遮挡验收）全部来自模拟器。
- 短边 360 dp / 4 GiB 设备与双客户端联机属于后续发布验收，不在本票范围。
