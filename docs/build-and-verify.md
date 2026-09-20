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
npm test                    # 全部单元与集成测试（协议 56 项 / 服务 16 项 / 客户端 37 项）
npm run typecheck           # 三个包的类型检查
npm run test:e2e            # 端到端验收：真实服务进程 + 客户端连接代码（含断线/主动断开）
npm run check:release-bundle # 正式产物中不得出现明文地址或回环地址
npm run service:start       # 启动服务（默认 127.0.0.1:8787）
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

**仍未完成**（不得以模拟器结论代替）：

- 真机验收：父规格要求至少一台真实 Android 设备，上述结论（包括软键盘像素级
  遮挡验收）全部来自模拟器。
- 短边 360 dp / 4 GiB 设备与双客户端联机属于后续发布验收，不在本票范围。
