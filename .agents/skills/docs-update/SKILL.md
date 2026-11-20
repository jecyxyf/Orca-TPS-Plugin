---
name: docs-update
description: 在 TPS Plugin 的用户可见功能、界面、工具支持或安装方式变更并验证后，同步维护中英文 README 与 Orca 官方插件目录的介绍和配图。
---

# 同步项目说明

根据本次代码改动和验证结果，确定用户会看到的变化，以及哪些说明或截图需要更新。只修改受影响的内容。

## 中英文 README

- 同步检查 `README.md` 和 `README.zh-CN.md`。保留现有章节与顺序，依次是项目描述、界面预览、功能描述、支持的 Harness、安装指南。功能归到对应的当前数据、个人统计或天梯榜小节。
- 沿用总览图放在界面预览、单页图放在功能小节的排版。界面改动涉及截图时，更新 `assets/readme/en/` 和 `assets/readme/zh-CN/` 中对应的真实界面图，使用示例数据。英文图配英文文档，中文图配中文文档。
- 保留现有缩略图排版和原比例。README 加载 WebP 缩略图，点击后打开对应的 PNG 原图。更新图片后，检查桌面和窄屏预览、图片路径及原图链接。

## Orca 官方插件介绍

- 检查 `orca-plugin.json` 的英文简介、主页、封面和截图。沿用现有结构，按需要更新文字和配图。简介突出用户能实际使用的功能。配图和标题应与发布版本一致。
- 核对 Git 差异和修改后的链接。清单或上架配图有变化时，运行 `orca plugin validate . --json`。

## 发布时核对

- 在用户已授权发布时，按当前 [Orca 上架流程](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md#4-list-it-in-the-orca-plugin-directory) 操作。确保 `orca-plugin.json`、`package.json` 和 `vX.Y.Z` 标签版本一致。
- 用对应的发布提交运行 `orca plugin release-entry . --json`，将 CLI 生成的提交号、内容哈希和配图等写入项目的 `orca-catalog.json` 新版本记录，保留已有版本。运行 `orca plugin validate orca-catalog.json`，核对推送的标签指向该发布提交。
- 发布后对照 [Orca 公开页](https://api.onorca.dev/plugins/jecyxyf/orca-tps-plugin) 和 [Orca 社区目录](https://github.com/stablyai/orca-community-plugins/blob/main/orca-catalog.json)，确认实际显示的版本。公开页仍显示旧版时，报告已推送的 GitHub 版本和 Orca 当前显示的版本。
