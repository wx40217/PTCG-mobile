# 单服务部署与本地交付

本说明供部署者使用。首版验收以 GitHub #1、#17、#18 为准；当前仍缺实体 Android 双端验收，不能将候选包或下述本地检查视为正式发布。

## 固定源码与构建

保存使用的提交号、Node.js 版本、APK 摘要和签名证书摘要。已验证的运行时是 Node.js 24.19.0；服务使用内置 SQLite。Android 工具版本及无签名 release 构建步骤见 [构建与验证](build-and-verify.md)。

在固定提交的源码根目录运行：

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run check:release-bundle
```

保留完整源码目录及生产依赖运行服务；单独复制 `packages/service/dist` 不足以提供协议工作区和卡牌目录。升级前保存旧源码版本，数据库、TLS 私钥及资源包放在源码目录之外。

## HTTPS/WSS 服务

准备客户端信任、主机名匹配且未过期的证书及私钥。以下示例在已有的 `D:\ptcg-data` 目录中保存持久状态，并仅绑定本机；不会自动配置域名、防火墙或公网入口。

```powershell
node packages/service/dist/main.js --host 127.0.0.1 --port 8787 --db D:\ptcg-data\identity.sqlite --catalog data/catalog/zh-cn-standard-2025-06-05-catalog.json --tls-cert D:\ptcg-data\cert.pem --tls-key D:\ptcg-data\key.pem
```

HTTPS 健康检查路径是 `/health`，WebSocket 路径是 `/ws`。两者共用一个进程和端口。发布 APK 输入 HTTPS 服务地址，自动派生 WSS 地址；普通自签名证书不会因服务能启动就自动被手机信任。不要关闭证书校验或启用混合内容来绕过错误。

若在已有反向代理后运行，代理需支持 WebSocket Upgrade，并把同一服务的 HTTP 接口和 `/ws` 一并转发。对外可达地址及证书由部署者配置；本项目的本地验证不代表公网接入已经完成。无 TLS 的回环监听只能用于受控代理后端或开发验证，不能直接作为发布 APK 的连接地址。

启动日志记录 PID、端口、协议版本、服务实例和是否启用 TLS。健康检查只证明进程可用，完整连接还必须完成 WSS 身份握手。保留受控日志并限制访问；日志可能含部署路径、房间码及设备标识，不应原样公开。不要记录身份私钥、TLS 私钥或完整握手原文。

卡图可通过 `--resource-bundle` 指定已校验的独立资源包；它不能与 `--card-image-dir` 同时设置。具体准备与校验命令见 [构建与验证](build-and-verify.md)。不要把未知原包、私服加载器或本机配置混入 APK 和服务分发目录。

## 停止、备份与恢复

前台运行时用 Ctrl+C 请求停止。服务代码处理 SIGINT/SIGTERM 并关闭监听及数据库；应核对进程退出、端口释放后再做离线备份。Windows 的强制结束进程不等于执行了优雅停止处理器。

关闭服务后，将持久化目录完整复制到新的备份目录，保留可能存在的 SQLite 附属文件。不要在运行中只复制数据库主文件；也不要在不知道现有目录用途时覆盖或删除它。TLS 私钥的备份应单独限制访问。

恢复时先停止当前服务，把备份复制到一个新的持久化目录，并用新的 `--db` 路径启动。核对 `/health`，再让原设备身份重新完成握手，确认无需重新注册。当前数据库保存设备身份；对局与房间是内存状态，服务重启不会恢复未完成的对局，客户端应显示无胜负中止，不能自行补造胜者。

## APK 与随包材料

`assembleRelease` 产出的 unsigned APK 还不能作为安装交付件。使用 Android SDK 的 `zipalign` 对齐，再用 `apksigner` 和仓库外的持久签名密钥签名，最后执行 `apksigner verify --verbose --print-certs`。记录最终 APK 的 SHA-256 和证书 SHA-256。密钥及密码不能进 Git；密码通过工具支持的环境变量或受保护输入提供，不写进命令文本或日志。

同一应用的更新需要兼容的签名。调试包与候选 release 包使用不同证书时，不要为安装测试直接卸载并丢失已有身份和卡组；应使用独立测试设备或先安排明确的数据保留方案。签名校验成功仍须安装、启动和真实对局验证。

交付目录应包含固定版本源码、项目 LICENSE、生产 npm 与 Android 运行时依赖的原始许可/NOTICE 文本，以及实际随包资源的来源说明。依赖清单应取自锁文件和 releaseRuntimeClasspath，不能只列直接依赖。应用代码许可不自动覆盖卡牌图片或其他第三方资源。
