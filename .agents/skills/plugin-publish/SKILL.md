---
name: plugin-publish
description: 负责 TPS Plugin 的版本发布和插件发布。核对版本号，同步中英文 README 与 Orca 插件目录资料，并在明确要求发布时创建 GitHub Release 和核验 Orca 插件目录。
---

# TPS Plugin 版本发布与插件发布

根据本次代码改动和验证结果，确定用户会看到的变化，以及哪些说明或截图需要更新。只修改受影响的内容。

## 插件版本

- 加载以版本号命名的开发分支或检查文档时，核对目标版本与 `orca-plugin.json`、`package.json` 的 `version`。用户指定了版本时，以指定版本为准。
- 更新版本时同步修改这两个字段，运行 `orca plugin validate . --json`。如果本地 Orca 已加载该分支，重新加载后核对运行状态和实际显示的版本。

## 中英文 README

- 同步检查 `README.md` 和 `README.zh-CN.md`。保留现有章节与顺序，依次是项目描述、界面预览、功能描述、支持的 Harness、安装指南。功能归到对应的当前数据、个人统计或天梯榜小节。
- 沿用总览图放在界面预览、单页图放在功能小节的排版。界面改动涉及截图时，更新 `assets/readme/en/` 和 `assets/readme/zh-CN/` 中对应的真实界面图，使用示例数据。英文图配英文文档，中文图配中文文档。
- 保留现有缩略图排版和原比例。README 加载 WebP 缩略图，点击后打开对应的 PNG 原图。更新图片后，检查桌面和窄屏预览、图片路径及原图链接。

## Orca 官方插件介绍

- 检查 `orca-plugin.json` 的英文简介、主页、封面和截图。沿用现有结构，按需要更新文字和配图。简介突出用户能实际使用的功能。配图和标题应与发布版本一致。
- 核对 Git 差异和修改后的链接。清单或上架配图有变化时，运行 `orca plugin validate . --json`。

## 发布时核对

只有用户明确要求发布时才操作。发布统一通过 **GitHub Release** 完成，不再单独推送标签。

1. **准备版本**：确认要发布的提交已经合并到 `main`，并按上面的规则核对两处版本号。在 `CHANGELOG.md` 添加 `X.Y.Z` 的版本小节，把 `[Unreleased]` 的内容移到该小节。
2. **写入目录记录**：用发布提交运行 `orca plugin release-entry . --json`，把 CLI 生成的提交号、内容哈希和配图写入 `orca-catalog.json` 的新版本记录，保留已有版本。运行 `orca plugin validate orca-catalog.json`。
3. **发布 Release**：在 GitHub 上新建 Release，标签填 `vX.Y.Z`，目标选发布提交（Release 会自动创建这个标签）；标题写 `TPS Plugin X.Y.Z`；说明使用 `CHANGELOG.md` 中该版本的内容。
   - 有 `gh` 时运行：`gh release create vX.Y.Z --target <发布提交> --title "TPS Plugin X.Y.Z" --notes-file <说明文件>`。
   - 没有 `gh` 或者没登录时，请用户运行 `! gh auth login` 登录，或者让用户在 GitHub 网页上按以上内容创建 Release。
4. **标签规则**：Orca 社区目录只收录 `vX.Y.Z` 标签，而且同一个版本以第一次看到的提交为准。不要单独推送、移动或删除已有的版本标签，也不要发布草稿 Release 或者预发布版本来代替正式版本。
5. **发布后核对**：确认 Release 的标签指向发布提交。对照 [Orca 公开页](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin) 和 [Orca 社区目录](https://github.com/stablyai/orca-community-plugins/blob/main/status.json)，看实际显示的版本。公开页仍显示旧版时，查看 `status.json` 里本仓库的状态和收录程序最近一次提交的时间，向用户报告 GitHub 上的最新 Release 和 Orca 当前显示的版本。
