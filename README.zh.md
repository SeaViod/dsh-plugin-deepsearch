# dsh-plugin-deepsearch

给 DSH 内置的 `web_search` 加一个开关：走 **DeepSeek Search API**（`POST /v1/tools/search`），还是走 DSH 默认的账号搜索。附带自动回退、设置页、侧栏开关和模型工具。

[English](README.md) | 中文说明

- **开关 ON（`deepseek-api`）** — 内置 `web_search` 改由 DeepSeek Search API 提供服务。这是付费接口：成功请求由 DeepSeek 计费，开启前请以 DeepSeek 控制台中的当前价格为准。
- **开关 OFF（`builtin`）** — DSH 默认路线：由账号在服务端完成搜索（一次搜索消耗一次模型轮次）。
- 切换**立即生效**，重启后仍保留：状态落盘在 `$DSH_HOME/deepsearch-mode.json`。
- **不会让搜索不可用。** 没有 key、401、网络错误、429/5xx 重试用尽时，提供方会回退到之前的（或其他可用的）搜索提供方，并在 `lastError` 里说明原因。
- **零运行时依赖** —— 只用 `node:` 内置模块和全局 `fetch`，没有构建步骤。
- 设置页与侧栏开关支持**中英双语**。

## 它做了什么

插件由两半组成，必须配合工作：

| 半侧 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 注册模型工具 `deepsearch`、注册搜索提供方（默认 id `deepseek-search-api`）、将 `web.searchProviderId` 切到本插件/切回、暴露 `/deepsearch/` 下的 4 个 HTTP 路由、解析 API key。 |
| 浏览器 | `client.js` | 通过 `window.__ModuleLoader__.load(...)` 加载的手写 bundle：设置页 tab + 侧栏底部开关。 |

`cordis.patch.yml` 是 bundle patch：用 `dsh plugin add`（或从插件市场）安装时，包会装进 profile 的 `node_modules`（并记在 profile `package.json` 的 `dsh.profile.bundles` 里），bundle 层在启动时应用它——**不需要**再手工改 profile 的 patch。

## 三个入口

| 入口 | 位置 | 用途 |
|---|---|---|
| 设置页 | **设置 → 内置插件 →「DeepSeek 搜索」** | 开关、状态详情、测试接口、API key 编辑 |
| 侧栏开关 | 左侧栏底部常驻 | 一键切换，显示当前路线（`API` / `builtin`） |
| 模型工具 | `deepsearch`（`status` / `on` / `off` / `search` / `fetch` / `check`） | 在对话里切换路线或直接发起搜索 |

## 安装

### 从插件市场安装

在 DSH 插件市场里搜索 **dsh-plugin-deepsearch**（或「DeepSeek 搜索」）并安装。市场会用包里的 `dsh.bundle.patch` 自动注册 Host 半侧。安装后，设置页 tab 出现在 **设置 → 内置插件 →「DeepSeek 搜索」**（英文界面为 **Settings → Built-in plugins → DeepSeek Search**）；第一次安装后可能需要刷新一次页面，浏览器才会加载到新的 client bundle。

### 从命令行安装

```pwsh
# 装进默认 profile
dsh plugin add dsh-plugin-deepsearch

# 或显式指定 profile：`web` 对应 dsh web 服务端
dsh plugin --profile web add dsh-plugin-deepsearch
```

**桌面端（Desktop app）** 使用 desktop profile / 应用内的插件市场 UI 安装（桌面端会用自己的 DSH home 管理 profile，不需要手输用户目录路径）。插件的浏览器半侧声明了 `dsh.client.platform: "web"`，桌面端的 web 壳同样会加载它。

如果是从仓库源码安装而不是从 registry 安装：先 `npm pack`，再用 `dsh plugin add` 安装生成的 tgz。

### 从 0.1.x 升级

0.1.x 没有 bundle patch，是手工安装的：在 profile 的 `cordis.patch.yml` 里加一条 insert：

```yaml
- insert:
    - id: deepsearch
      name: dsh-plugin-deepsearch
```

0.2.0 起带上了 `dsh.bundle.patch`（包根目录的 `cordis.patch.yml`）。`dsh plugin add` 或插件市场安装**不会**往 profile patch 里写 insert 记录：它把包装进 profile 的 `node_modules`，记到 profile `package.json` 的 `dsh.profile.bundles` 里，再由 bundle 层在启动时应用包自带的 `cordis.patch.yml`。**在以 bundle 方式安装 0.2.0 之前，请先删掉手工加的那条 insert**——手写的 insert 加上 bundle 安装会把同一个插件加载两次。`$DSH_HOME` 下的开关状态文件与 key 文件会保留，所以升级后开关状态和 key 都还在。

profile 名字因客户端而异：`dsh web` 服务端用 `dsh plugin --profile web add dsh-plugin-deepsearch`；桌面端用 `desktop` profile 和它的插件市场 UI。**不要手写完整 profile 路径**，让 `dsh plugin` 自己解析。

### 卸载

从 profile 卸载这个包（或在插件市场里卸载）即可，插件不会往 profile 里加别的文件。`$DSH_HOME` 下的 `deepsearch-mode.json`（状态）、`deepsearch-diag.json`（诊断）和可选的 `deepsearch-key.txt`（key 文件）可以删掉，也可以留着以后重装用。

## 配置

配置来自 profile patch 中本插件条目的 `config` 块；所有值都会被规范化，非法值回退默认值而不会抛错：

```yaml
- insert:
    - id: deepsearch
      name: dsh-plugin-deepsearch
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        count: 8
        retryCount: 1
```

所有 key 都是可选的。下表与 Host 的配置 schema 一致，bundle 安装也可以携带同样的 `config`。

| 配置项 | 默认值 | 规范化 / 含义 |
|---|---|---|
| `apiKey` | `''` | 内联 API key。字符串，去首尾空白；空字符串表示未设置。不推荐：它会留在 patch 文件里。任何路由都不会回显它。 |
| `apiKeyEnv` | `'DEEPSEEK_API_KEY'` | 要解析的凭据引用 / 环境变量名。必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`，否则使用默认值。 |
| `baseURL` | `'https://api.deepseek.com'` | API 根地址。去首尾空白；必须能解析为 `http(s)` URL；末尾斜杠会被去掉。 |
| `searchPath` | `'/v1/tools/search'` | 搜索接口路径（拼在 `baseURL` 后）。去空白、强制以 `/` 开头；含 `?` 或 `#` 的值会被拒绝；空值回退默认。 |
| `fetchPath` | `'/v1/tools/fetch'` | 抓网页接口路径（规则同 `searchPath`）。 |
| `keyFile` | `''` | 文件形式的 key 路径。`''` 表示 `$DSH_HOME/deepsearch-key.txt`；`~/...` 展开到用户主目录；相对路径解析到 `$DSH_HOME` 下；其他按绝对路径使用。 |
| `count` | `8` | 搜索结果条数。整数，夹取到 1..50。 |
| `needContent` | `false` | 是否让搜索接口返回正文（只影响直接调用 `deepsearch search`）。只有严格的 `true` 才开启。 |
| `timeoutMs` | `30000` | 单次 HTTP 请求超时。整数，夹取到 1000..120000。 |
| `retryCount` | `1` | 首次之外的重试次数（针对 408/429/5xx）。整数，夹取到 0..3。 |
| `retryDelayMs` | `1200` | 两次重试之间的等待时间。整数，夹取到 100..10000。 |
| `maxFetchChars` | `20000` | `fetch` / 请求正文的 `search` 工具最多返回的字符数。整数，夹取到 1000..200000。 |
| `providerId` | `'deepseek-search-api'` | 注册的搜索提供方 id。必须匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`，且不能与已存在的其他提供方冲突（本插件自己的重复注册除外）。 |
| `fallbackProvider` | `''` | 关闭开关时优先回退到的提供方 id。空字符串表示自动判断（先前使用的提供方，然后是第一个可用的非本插件提供方）。 |
| `fallbackOnError` | `true` | Search API 调用失败时是否回退到其他提供方。只有严格的 `true` 才开启。 |
| `language` | `'auto'` | `auto` / `en` / `zh`。`auto` 依次读取 `DSH_LANGUAGE`、`DSH_LOCALE`、`LANG`、`LC_ALL`（中文 locale 解析为 `zh`，其余为 `en`）。 |
| `checkQuery` | `'DeepSeek'` | 「测试接口」按钮使用的查询词。去空白、非空、最长 128 个字符。 |

规范化后的 `config` 会通过插件状态（以及 `deepsearch` 工具的 `status` 动作）只读暴露，**不含 `apiKey`**。key 本身永远不会出现在诊断、日志或任何响应体里。

## API Key

Search API 需要 DeepSeek 官方 API key。按以下顺序解析，命中即停：

1. patch `config` 里的 **`apiKey`**（内联，不推荐）。
2. **DSH 凭据**：`apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）对应的凭据引用——与 DSH 自带的 **设置 → 内置插件 → 网页搜索** 页保存的是同一个引用，本插件复用它。
3. **环境变量** `process.env[apiKeyEnv]`。
4. **key 文件**（`keyFile`，默认 `$DSH_HOME/deepsearch-key.txt`，第一行是 key）。设置页可以帮你保存/清除这个文件。
5. **`$DSH_HOME/.env`** 里的一行 `DEEPSEEK_API_KEY=sk-...`（变量名跟随 `apiKeyEnv`）。

在设置页或 `deepsearch status` 里确认结果：`key.configured` 表示是否找到 key，`key.kind` 是 `config`、`credentials`、`env`、`file`、`env-file` 之一，`key.source` 给出具体来源（环境变量名或文件路径）；`key.hint` 会用当前界面语言给出同样的说明。

key 处理规则：

- key 只在发起请求时读取，不会被打印、记录日志、写进诊断文件，也不会被任何路由返回。
- 设置页提供密码输入框 + **保存** / **清除** 按钮。保存会把 key 写到配置的 key 文件（尽力设置文件权限 `0600`）；保存后不会再渲染出 key 的值。
- **没有 key 也不会坏**：开关可以保持 ON，提供方会回退到默认账号搜索并说明原因。

## 切换与回退

- 打开开关（**ON**）时，如果当前激活的搜索提供方不是本插件，会先把它记为 `previousProviderId`，再把 `web.searchProviderId` 设为本插件的提供方。
- 关闭开关（**OFF**）时按以下顺序恢复：记住的前一个提供方（若仍注册）→ 配置的 `fallbackProvider` → 第一个已注册、不是本插件且未被标记不可用的提供方 → 最后退而使用记住的前一个提供方（即使它已不在注册表里，作为最佳猜测）。如果没有任何其他提供方，保持当前提供方并返回错误，绝不清空 id。插件不会硬编码 `deepseek-official`。
- **提供方级错误回退：** 若 `fallbackOnError` 为真且 Search API 调用失败（缺 key、401、网络错误、重试用尽），同样的解析逻辑会选一个其他提供方并返回其结果，记录 `kind: 'provider.fallback'`。`fallbackOnError: false` 时始终抛出原始的结构化错误。
- **取消和超时永不回退** —— 调用方已取消或请求已超时后，不会偷偷再跑一次账号搜索。
- 提供方的 `available()` 恒为 `true`：缺 key 或 API 故障不会让内置 `web_search` 消失，只会降级到回退。

## 设置页与侧栏开关

- **设置 → 内置插件 →「DeepSeek 搜索」**：开关（`role="switch"` 并带 ARIA 属性）、状态行、「测试接口」按钮、详情网格（模式、当前提供方、key 来源、搜索/抓取接口、结果条数、最近调用、最近错误）、API key 编辑区、无 key 时的提示，以及诊断里的接线警告。页面每 5 秒轮询一次状态。
- **侧栏底部开关**：一键切换，显示当前走 `API` 还是 `builtin` 路线，带本地化 tooltip。每 8 秒轮询一次。

所有页面文案都来自插件自己的 `dsh-plugin-deepsearch` locale 词典（中文 / 英文），会跟随 DSH 的语言设置。

## 模型工具

Host 注册一个面向模型的工具，名字是 `deepsearch`：

| 动作 | 作用 |
|---|---|
| `status` | 返回当前模式、提供方路由、key 状态（不含 key）、接口地址、最近结果/错误。 |
| `on` / `off` | 与 UI 开关走同一套逻辑切换路线。 |
| `search` | 直接调用 Search API，参数 `{ query, count?, needContent? }`；开启回退时失败会自动回退。 |
| `fetch` | 通过 `/v1/tools/fetch` 抓取一个 URL，返回截断后的正文和元数据。 |
| `check` | 用一次最小查询验证接口连通性，供「测试接口」按钮和快速自检使用。 |

也可以直接在对话里说「打开 / 关闭 DeepSeek 搜索」，agent 会调用 `deepsearch` 工具切换；工具描述里会写明设置页的英文位置，以及配置写在 profile patch 里。

## HTTP 路由

浏览器半侧通过 `/deepsearch/` 下的四个路由与 Host 通信：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/deepsearch/state` | 状态快照（不含 key）。 |
| `POST` | `/deepsearch/mode` | 设置模式：`{ "mode": "on" }` / `{ "mode": "off" }`。 |
| `POST` | `/deepsearch/check` | 单飞的接口连通性检查。 |
| `POST` | `/deepsearch/key` | 保存/清除 key 文件：`{ "action": "save", "key": "..." }` / `{ "action": "clear" }`。绝不回显 key。 |

这些路由不走 DSH connection 鉴权，所以 Host 自行校验：只接受约定的 method；POST 必须 `content-type: application/json`、浏览器 `Origin` 与 `Host` 同源；拒绝 `Sec-Fetch-Site: cross-site`；`/check` 单飞（同时只允许一个请求）。这能挡一般 CSRF，但不替代鉴权——DSH 的 web 服务仍应只监听本机。

## 安全与可靠性

- `apply()` 永不抛错；坏配置会被规范化，而不是让宿主崩溃。
- API key 不会被记录日志、回显、由路由持久化，也不在状态快照里；唯一的写入是显式保存动作（文件权限 `0600`，Windows 上尽力而为）。
- 取消和超时不会触发回退搜索；回退目标失败时以结构化错误结束，而不是在别处静默重试。
- 重试只会在 `408`/`429`/`5xx` 上做 `retryCount` 次额外尝试，间隔可配置；`401` 映射为凭据错误，不会进入重试循环。
- `lastError` 用英文 scope 字符串记录，并在下一次成功调用时清掉，避免页面一直显示过期错误。
- 零运行时依赖、没有构建步骤：只用 Node 内置模块和全局 `fetch`。

## 兼容性

- **DSH：** `>=0.1.7-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0-0`（声明在 `package.json` 的 `engines.dsh` 里）。显式预发布分支让 `0.2.0-rc.2` 这类宿主能被正确解析；单个宽范围会静默排除预发布版本。
- **Node：** Host 半侧与测试套件要求 `>=20`（已在 Node 24 上验证）。
- **Profile：** `web`（浏览器访问的 DSH）与桌面端（Desktop app）；浏览器半侧声明 `dsh.client.platform: "web"`。
- **无第三方包**、无 post-install 脚本，不需要 `allowBuilds` 之类的构建授权。

## 开发与测试

仓库是零依赖的纯 ESM 包，跑测试不需要安装任何东西。所有测试文件都是普通 Node 脚本，打印 `ok`/`FAIL`，失败时以非零码退出（不用测试框架）；测试全程离线，host/client 测试会 mock `fetch`。

```sh
node test/package.test.mjs   # 清单、bundle patch、文档与版本一致性
node test/host.test.mjs      # Host 半侧：假 Cordis ctx + mock fetch
node test/client.test.mjs    # 浏览器 bundle：假 module loader / react / locale
```

或者按顺序全部跑：

```sh
npm test
```

`npm publish` 会通过 `prepublishOnly` 跑同一套测试。CI 只需在 Node 20/22/24 上跑 `npm test`，不需要 `npm install` 步骤，就足以保证这个包始终处于可收录状态（见 [PUBLISHING.md](PUBLISHING.md)）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：`deepsearch` 工具、搜索提供方、路线切换、HTTP 路由、key 解析。 |
| `client.js` | 浏览器半侧：设置页 tab + 侧栏开关（手写 bundle，无构建步骤）。 |
| `cordis.patch.yml` | Bundle patch：`dsh plugin add` 时注册 Host 半侧。 |
| `package.json` | 包清单、`dsh.bundle` / `dsh.client` 元数据、版本唯一来源。 |
| `README.md` / `README.zh.md` | 英文 / 中文文档（本文件与英文版）。 |
| `CHANGELOG.md` | 版本历史。 |
| `PUBLISHING.md` | 维护者清单：身份替换、npm 发布、市场投稿。 |
| `LICENSE` | MIT。 |
| `icon.svg` | 插件市场使用的小方图标。 |
| `test/` | 打包、Host、浏览器三套测试。 |

## 许可证

[MIT](LICENSE)。Copyright (c) 2026 SeaViod。

问题或 bug 反馈：[提交 issue](https://github.com/SeaViod/dsh-plugin-deepsearch/issues)。
