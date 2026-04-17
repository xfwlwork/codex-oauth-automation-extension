# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when when working with code in this repository.

## 项目概述

这是一个 Chrome 扩展，用于自动化执行 ChatGPT OAuth 注册/登录流程。支持侧边栏单步执行和全自动多轮运行，兼容多种验证码接收方式（QQ Mail、163 Mail、Inbucket、Hotmail、DuckDuckGo、Cloudflare）。

## 开发命令

```bash
# 运行全部测试
node --test tests/*.test.js

# 运行单个测试文件
node --test tests/background-step-modules.test.js
```

测试基于 Node.js 原生 `node:test` 模块，无需额外安装。

## 架构结构

### 核心分层

```
background.js                  后台入口壳文件（装配层 + 消息路由调度）
background/                    后台业务模块
  steps/                       步骤实现（step-1~step-9 的语义化文件）
    registry.js                步骤注册表，管理步骤顺序和执行
  auto-run-controller.js       Auto 多轮运行控制器
  message-router.js            消息分发路由
  verification-flow.js         验证码轮询通用流程
  panel-bridge.js              CPA/SUB2API 面板交互桥接
  tab-runtime.js               Tab 生命周期管理
  navigation-utils.js          导航与页面跳转工具
  logging-status.js            日志与状态记录
  account-run-history.js       账号运行历史
  signup-flow-helpers.js       注册流程辅助
  generated-email-helpers.js   邮箱生成辅助
content/                       Content scripts（注入目标页面）
  signup-page.js               OpenAI 注册/登录页操作（Step 1/2/3/5/6/8）
  qq-mail.js / mail-163.js / inbucket-mail.js / icloud-mail.js  邮箱轮询
  duck-mail.js                 DuckDuckGo 邮箱生成
  vps-panel.js                 CPA 面板 Step 9 回调
  sub2api-panel.js             SUB2API 面板交互
  activation-utils.js          页面激活通用工具
  utils.js                     Content script 通用工具
sidepanel/                     侧边栏 UI
  sidepanel.html / js / css    UI 主体
  *-manager.js                 各领域配置管理器（hotmail/icloud/luckmail）
data/
  step-definitions.js          步骤定义共享文件（标题、顺序、key）
  names.js                     随机姓名/生日数据
```

### 关键架构原则

1. **background.js 是壳文件**：保持入口装配和消息调度，业务逻辑下沉到 `background/` 模块
2. **步骤定义共享**：`data/step-definitions.js` 是步骤元数据的单一事实来源，sidepanel 和 registry 都从它读取
3. **步骤注册表**：`background/steps/registry.js` 管理步骤执行顺序和调度
4. **不要往 background.js 或 sidepanel.js 直接塞大段逻辑**，应下沉到对应模块

### 新增步骤时必须同步更新

1. 新增步骤文件到 `background/steps/`
2. 更新 `data/step-definitions.js`
3. 更新 `background/steps/registry.js`
4. 检查 sidepanel 动态步骤渲染
5. 检查 auto-run 集成
6. 补充测试

### 数据流

- 运行时状态使用 `chrome.storage.session`（会话级）
- 配置项使用 `chrome.storage.local`（持久化）
- 扩展与 content scripts 通过 `chrome.runtime.sendMessage` 通信

## 9 步工作流

| 步骤 | Key | 功能 |
|------|-----|------|
| 1 | `open-chatgpt` | 打开 chatgpt.com 确认页面就绪 |
| 2 | `signup-email` | 点击注册、填写邮箱 |
| 3 | `fill-password` | 填写注册密码 |
| 4 | `get-signup-code` | 轮询邮箱获取注册验证码 |
| 5 | `fill-name-birthday` | 填写姓名/生日完成账户创建 |
| 6 | `login-via-oauth` | 通过 OAuth 链接重新登录 |
| 7 | `get-login-code` | 轮询邮箱获取登录验证码 |
| 8 | `manual-oauth-confirm` | 自动点击 OAuth 同意页"继续"按钮，捕获 localhost 回调 |
| 9 | `cpa-verify` | 回到 CPA 面板提交回调 URL 验证 |

## 文档规范

如果代码改动影响了项目结构、功能链路或开发边界，需要同步更新以下文档：
- `README.md` — 用户使用文档
- `项目文件结构说明.md` — 文件结构
- `项目完整链路说明.md` — 功能链路
- `项目开发规范（AI协作）.md` — 开发规范
