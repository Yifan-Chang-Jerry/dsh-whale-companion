# 第三方依赖与许可资料

这里记录固定 DSH 源码版本下采集到的 1,912 个包版本，包括工作区、JavaScript 依赖、桌宠与智能体组件，以及 14 个 Python 工具发行包（含 pip）；也包含运行、构建、测试及可选依赖；列入清单不表示每个包都会在桌宠中执行。清单基于当前 macOS Apple Silicon 环境，其他平台安装结果可能不同。构建时使用 Node.js 24.19.0，主运行时锁定 Node.js 24.21.0。版本、作者和许可证声明来自包元数据；未采集到的信息显示为 `—`，并不代表不存在作者或许可证。

- [JavaScript 依赖与工具](javascript.md)
- [DSH 源码工作区](harness.md)
- [Python 发行包](python.md)
- [桌宠组件](companion.md)
- [机器可读清单](dependencies.json)，含采集范围、注册表、仓库与许可文件路径。
- [已取得的包版权及许可文件](licenses/)、[Node.js 运行时许可](node-runtime-LICENSE.txt)、[Electron 和 Chromium 第三方声明](electron-chromium-notices.html)、[DSH pnpm 锁定文件](harness-pnpm-lock.yaml)、[主运行时锁定信息](primary-runtime-lock.json)。

## 元数据例外

- [`buffers` 0.1.1](https://www.npmjs.com/package/buffers/v/0.1.1) 未声明许可证，其原仓库当前返回 404。
- [`@modelcontextprotocol/server-everything` 2026.8.31](https://www.npmjs.com/package/@modelcontextprotocol/server-everything/v/2026.8.31) 和 [`@modelcontextprotocol/server-filesystem` 2026.8.31](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem/v/2026.8.31) 的元数据写有 `SEE LICENSE IN LICENSE`，但对应 npm 包缺少该文件。
- `khroma` 2.1.0 与 `union` 0.5.0 的 MIT 声明依据各自包内完整许可正文补齐，正文可从上方依赖表访问。

上述例外属于采集到的旧开发依赖元数据，本仓库不重新分发这些包的源码；使用者应向原包和权利人核实。此清单不是法律审查结论，也不保证每份包元数据完整或准确。项目级说明及模型许可边界见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
