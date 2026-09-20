# PTCG-mobile

面向简体中文环境的独立 PTCG 安卓客户端：自由组卡、朋友房间对战、自动结算。

目前已有首个纵向链路的最小实现：协议契约（`packages/protocol`）、最小服务
（`packages/service`）与 React/Capacitor 安卓客户端（`packages/client`）。卡牌
目录已贯穿「冻结资料 → 版本化目录服务 → 安卓搜索/详情/资源样本/离线缓存」
（T04）；组卡与对战内核尚未实现。可重复的构建、测试与 APK 命令，以及当前的
已验/未验清单，见 [构建与验证](docs/build-and-verify.md)。发布包只接受
HTTPS/WSS；局域网明文只在开发构建中开放（debug 变体通过独立的 debug 资产
覆盖 WebView 混合内容设置）。

## 实施入口

1. 读取 [领域术语](CONTEXT.md) 和相关 [决策记录](docs/adr/)。
2. 读取 GitHub [首版主规格 #1](https://github.com/wx40217/PTCG-mobile/issues/1) 及其子任务。规格和 tickets 以 GitHub Issues 为权威来源，本文件不复制其正文。
3. 选择阻塞项已全部完成的任务；开始前读取完整正文、评论和原生依赖。`ready-for-agent` 表示规格可执行，不表示依赖已满足或工作已完成。
4. 在任务内记录行为验证证据；只有验收条件全部满足才能关闭任务。父规格需要整体发布验收，不能因某张票或构建通过而关闭。

首次可从 [#2：冻结环境、卡表与资源证据](https://github.com/wx40217/PTCG-mobile/issues/2) 开始；[#4：安卓昵称入口与服务连接](https://github.com/wx40217/PTCG-mobile/issues/4) 无前置依赖，可独立推进。

在本轮规划结束时，共有一个主规格、17 张子任务和 20 条阻塞依赖。可运行的构建、
测试与 APK 命令见 [构建与验证](docs/build-and-verify.md)；实际工具链版本已在该文档
中固定，关键工具包的 SHA-256 已与官方发布摘要核对一致。

## 参考输入

- [YGOMobile 源码](https://github.com/fallenstardust/YGOMobile-cn-ko-en) 与 [产品介绍](https://ygom.top/)：移动端组卡和对战体验参考。
- 用户本机已有 PTCG Live 和私服相关工具，供交互与行为参考；未确认存在可直接使用的私服服务器源码。
- 用户提供的 Z 盘卡图候选文件名为 `中文卡牌图片资源包_2025060501.asar`。此前仅检查索引和少量头部，首项是 UnityFS 资源，尚未验证图像提取、实际语言和卡牌映射。实现时用显式本地输入路径，不将原包或私有配置提交仓库。
- 官方客户端位于用户 D 盘的 `moregame` → `PTCG` → `Pokémon Trading Card Game Live` 文件夹。存在托管规则相关程序集不等于已证实可以复用；规则引擎选择以技术前置票结论为准。

Issue 操作与标签约定见 [issue tracker](docs/agents/issue-tracker.md) 和 [triage labels](docs/agents/triage-labels.md)。
