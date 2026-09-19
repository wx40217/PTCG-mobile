# 使用 Web 技术构建安卓端，规则由独立服务裁定

首版采用 TypeScript、React/Vite 和 Capacitor 构建安卓客户端，采用 Node.js 单服务进程、WebSocket 和 SQLite 支撑朋友联机。这样能共享数据契约并用浏览器自动化验证大部分交互，代价是必须另行验证 Android WebView 的触控、布局与生命周期；浏览器通过不代表安卓验收通过。

服务端是对局状态和随机结果的唯一权威，客户端仅提交玩家意图，接收按座位过滤后的可见状态。规则实现通过独立的对局会话边界接入，优先评估已有开源引擎，不预设从零重写，也不让第三方引擎的完整状态直接成为网络协议。

这是实施路线决定，尚未实现。具体依赖版本和引擎适配结果由 [技术前置票](https://github.com/wx40217/PTCG-mobile/issues/3) 验证；约束与验收以 [主规格](https://github.com/wx40217/PTCG-mobile/issues/1) 为准。
