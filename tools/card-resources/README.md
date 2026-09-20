# card-resources

独立于玩家 APK 与规则代码的资源准备流程（T15 / #16）。

它把 T01 已核实的官方商品文章图整理成可导入的卡图资源包：清单含版本、大小、
摘要、出处与规则/印刷身份映射，图片字节仍只保存在部署者本机。玩家端不会运行
这个工具，也不需要私服工具或 NAS。

```sh
# 1. 把 T01 已核实卡图导出到 <inputs>，文件名用卡片 id（如 csv3c-043.png）。
node tools/card-resources/build-resource-bundle.mjs --inputs <inputs> --out <bundle>

# 2. 部署时让服务直接装载资源包（与 --card-image-dir 二选一）：
node packages/service/dist/main.js --host 127.0.0.1 --port 8787 \
  --resource-bundle <bundle>
```

规则与边界：

- **只处理所选首发资源**：目录卡牌 id → 印刷身份/官方文章图哈希的映射来自冻结
  目录产物；目录里没有 `imageSource` 的 id、以及输入目录里没有对应卡牌的图片
  都会被明确忽略，不会被猜测成某张卡。
- **不能靠文件名或 `_en_` 推断**：每张输入图片的 SHA-256 必须等于 T01 在目录中
  记录的 `imageSource.sha256`，否则整包构建失败，不产生半成品。
- **结构与方向检查**：图片必须是签名、IHDR、IEND 完整的 PNG，且为竖版卡面
  （高 > 宽）；横版、截图、截断文件都会被拒绝。
- **显式输入**：`--entry <cardId>=<相对路径>` 可指定输入文件名；相对路径在
  `--inputs` 目录内解析，拒绝目录穿越与符号链接。工具不扫描 NAS，也不修改源包。
- **清单可核验**：`bundleVersion` 是映射与元数据规范 JSON 的 SHA-256；`--check`
  会重算版本并逐文件核对大小/哈希，还会拒绝资源包内未映射的多余图片。
- **字节不入库、不外传**：`manifest.json` 只含元数据；`images/` 下的图片由部署者
  本机保存，仓库不提交原始数据。

```sh
node --test tools/card-resources/build-resource-bundle.test.mjs
```

与服务、客户端的关系：

- 服务启动时验证资源包清单版本、条目映射与文件字节，只把通过校验的卡目标为
  可用；失败条目保持不可用，目录文字与文字卡面兜底不受影响。
- 客户端按目录声明的 `sha256` 按需下载并缓存在应用私有目录；缓存清单同样记录
  版本、大小与摘要，更新中断/磁盘不足/损坏时保留上一完整版本。
