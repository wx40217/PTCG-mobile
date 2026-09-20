# card-catalog

把 T01 冻结资料整理成 T04 的版本化目录产物。

```sh
node tools/card-catalog/build-catalog.mjs          # 校验产物是否最新
node tools/card-catalog/build-catalog.mjs --write  # 重新生成产物
node --test tools/card-catalog/build-catalog.test.mjs
```

- 产物：`data/catalog/zh-cn-standard-2025-06-05-catalog.json`（提交入库）。
- 输入：环境快照、两份卡牌详情、身份表、四套卡表、效果矩阵，以及
  `data/catalog/zh-cn-standard-2025-06-05-resources.json`（本机资源样本的
  **元数据**）。
- `catalogVersion` 是规范化内容（对象键排序）的 SHA-256；服务启动时和客户端
  缓存读取时都用 `packages/protocol/src/catalog.ts` 的同一函数复核。
- 图片字节不进入产物：卡图可用性由服务运行时按本机配置的目录覆盖
  （见 `docs/build-and-verify.md` 的「卡牌目录与资源服务」）。
