# CHROMA — 松下 LUT 生成器

用自然语言生成适配松下 Lumix 相机的 `.cube` LUT 文件，支持机内烧录(Real-Time LUT)与后期软件两用。调色工作区已实现创作目标、参数保护、草稿与撤销、可复用风格保存、多样张验证和版本比较。

## 功能

- **会话式 LUT 生成**:描述想要的风格(如「日系清透」「电影青橙」),大模型多轮确认后生成 `.cube` 文件
- **创作目标**:新工作区默认“保留氛围”，可切换“自然校正”或“只调整风格”。保留氛围不默认纠正夕阳暖调或暗调，不执行曝光与灰世界白平衡兜底
- **参数保护**:锁定单项、RGB 三通道字段或整组；对话、自动修图、手调、复位与资产应用遵守锁。AI 自动修图始终保留输入基准与显示映射
- **草稿与撤销**:参数、目标、锁、来源与最近 100 条操作历史保存到本机浏览器；一次拖动或一次自动修图可整体撤销/重做，刷新恢复有效草稿
- **风格资产**:分别保存包含单张校正的完整效果与相对追加的可复用风格。保存有独立候选预览，不改变当前草稿；账号内保留资产修订
- **多样张预览与验证**:最多 5 张样张共用一套 LUT；一张主样张用于 AI，其他图片用于预览与确定性统计，查看缩略图不会切换 AI 主图
- **命名版本与 A/B**:每个工作区最多 20 个账号版本，选择时固定 A/B 快照；查看不改参数，恢复版本是一条可撤销事务
- **AI 自动修图**:以主样张和当前参数分析，可叠加自然语言风格；报告分别展示画面观察、目标冲突、实际调整与受阻原因
- **精细调色**:34 个参数字段,按单张校正、风格强度、影调、全局与局部色彩、阴影/中间调/高光染色、RGB 分通道和输入基准分组。风格强度可在技术转换与完整效果之间调整
- **输入与相机引导**:读取可用的相机型号和 EXIF 色彩空间供核对；Photo Style 仍由用户确认。提供当前输入/输出说明、S5II/S5IIX 导入参考、异常排查与使用说明下载
- **图像诊断**:选中真实样张并确认匹配输入后，显示缩小预览的亮度/RGB 直方图、裁切风险与技术中性基线差异；提供风险叠加和现有曲线/局部色相范围示意
- **资产库组织**:搜索名称/描述/标签，按种类、输入、收藏和分组筛选，并按时间/名称排序；标签、描述、收藏、分组、内置封面编辑独立保存，纯信息修改不新增调色修订
- **自动修图过程控制**:显示服务端真实阶段，支持请求取消、安全重试与部分完成结果续跑；请求幂等恢复，续跑核对当前参数与照片来源；取消在安全边界确认后生效，保存开始后会明确提示不能取消

新增图像与调色扩展：

- **统一色彩管理**：有效 ICC 的普通照片统一转换到 sRGB，方向统一，预览与分析使用同一规范化解码；V-Log 保留原编码。无 ICC 的 RGB 明确提示假定 sRGB，旧预览需重新绑定后更新。
- **刷新恢复作业**：提交前持久保存冻结请求摘要；刷新继续查询与冻结编辑。核对来源后恢复正式候选，以作业 UUID 防止重复应用，确认草稿保存后才完成回执。已正式保存的结果可在服务重启后恢复。
- **参考图匹配**：独立上传参考照片，选择色彩/影调及强度，在现有参数内寻找受保护、通过风险检查的候选；预览后明确应用，一次撤销。统计接近不代表艺术效果一致，不调用模型。
- **外部 .cube**：账号内导入纯3D 2–65点文件并确认信号；同编码显示风格支持强度，VLOG→Rec709替换系统技术转换且固定100%。预览、照片与LUT导出使用同一合成效果。
- **自由曲线**：主曲线与RGB曲线，每通道2–16点，单调PCHIP；拖动、键盘与精确百分比输入，删除、通道复位、保护和撤销。曲线及外部字段由手动入口控制，AI保留当前设置。
- **调整后照片导出**：从已绑定原文件按完整33³ LUT渲染原分辨率JPEG/PNG，嵌入sRGB ICC并移除原EXIF/GPS；PNG无损保存8位调整结果，JPEG质量可调。

本轮方案见[图像与调色扩展设计](docs/specs/extended-grading-design.md)，检查结果见[扩展验收记录](docs/specs/extended-grading-validation.md)。此前使用完善记录见[原验收记录](docs/specs/product-readiness-validation.md)。真实模型效果矩阵与相机实拍验收按用户要求继续待办。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + WebGL2(3D LUT GPU 叠加) |
| 后端 | Python 3.11+ + FastAPI |
| 会话编排 | 显式流程(agent/graph.py)+ 官方 openai SDK 的 tool calling(默认 DeepSeek) |
| 存储 | MySQL 8.0 |
| LUT 引擎 | numpy 自研参数化 3D LUT(33³) |

> 参数提取走 **tool calling** 而非「要求模型输出 JSON 再正则解析」:工具入参由服务端按 JSON Schema 约束,
> 且 schema 直接由 `agent/schemas.py` 的 pydantic 模型生成,模型可见约束与校验逻辑共用一份定义。

## 目录结构

```
├── backend/
│   ├── lut_engine/        # LUT 引擎(纯库):参数 → 3D LUT → .cube
│   ├── photo/             # 自动修图的计算层,不依赖框架:
│   │                      #   stats(测量)/ quality(判定)/ render(渲染)/ fixtures(合成样张)
│   ├── agent/             # 会话流程 + LLM(tool calling)参数提取
│   │                      #   auto.py = 自动修图编排(测量→提议→硬校验→风格→复检)
│   ├── api/               # FastAPI 路由
│   ├── storage/           # MySQL 存储
│   ├── scripts/           # 工具脚本(生成 golden 用例等)
│   └── tests/             # 后端测试
├── frontend/
│   ├── src/lib/           # LUT 引擎、WebGL 预览、工作区事务、风格配方与本机草稿存储
│   ├── src/components/    # 工作区工具条、样张、版本、保存候选、比较与自动修图报告
│   ├── src/hooks/         # useWorkspace(草稿与历史)、usePreview(WebGL 预览生命周期)
│   ├── src/App.jsx        # 生成页编排
│   ├── src/App.css        # 全部样式
│   ├── scripts/           # 一致性与前端单测脚本
│   └── prototype/         # UI 原型(HTML,含可交互的自动修图原型)
├── docs/                  # 设计文档与遗留问题清单
├── Makefile               # 启动/停止/测试脚本
└── .env                   # LLM key / JWT 密钥 / MySQL 连接(不入库)
```

## 环境要求

- Python 3.11+
- Node 18+
- MySQL 8.0

## 快速开始

```bash
# 1. 初始化 MySQL 数据库(默认 root/123456/chroma,可环境变量覆盖)
make db-init

# 2. 安装前后端依赖
make install

# 3. 配置环境变量
cp .env.example .env
#   ⚠ 模板里的 CHROMA_JWT_SECRET 是占位值,直接启动会被**拒绝**(见「认证」)。
#     先生成一个真实密钥:
#     python3 -c "import secrets; print(secrets.token_urlsafe(48))"
#   然后编辑 .env,至少填这两项:
#     CHROMA_LLM_API_KEY=<你的 DeepSeek key>
#     CHROMA_JWT_SECRET=<上一步生成的随机串>

# 4. 创建一个本地账号(默认 admin / 12345678)
make admin
#   自定义:make admin NAME=me PW=mysecret123

# 5. 启动前后端
make dev
# 访问 http://localhost:5173
```

停止 / 重启 / 测试:

```bash
make stop      # 停止前后端
make restart   # 重启
make test      # 运行后端测试
```

## 配置

### LLM(默认 DeepSeek)

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `CHROMA_LLM_MODEL` | 模型名 | `deepseek-flash` |
| `CHROMA_LLM_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `CHROMA_LLM_API_KEY` | API key | 无(必须配置) |
| `CHROMA_LLM_MAX_TOKENS` | 单次最大 token | `2000` |
| `CHROMA_LLM_TIMEOUT` | 单次请求超时(秒) | `30` |

key 优先级:`CHROMA_LLM_API_KEY`(环境变量或项目根 `.env`)> `OPENAI_API_KEY`。换其他 OpenAI 兼容服务只需改这几个环境变量。

模型选择(实测结论,先看这段再改模型):

| 模型 | 思考模式 | 抽取场景实测开销 | 相对描述 |
|---|---|---|---|
| `deepseek-flash`(默认) | **默认开启**(`reasoning_effort` 默认 `high`) | completion ≈130~420,1~2.3s | 表现正常 |
| `deepseek-v4-pro` | 同上 | 思考开销更大 | 抽查中出现过把「再暖一点」误判为 `intent=confirm` |

> **两个模型都会思考,别按「哪个是 thinking 模型」来选。** DeepSeek 文档明确写了 thinking mode
> **默认开启**,且 Thinking Mode / Tool Calls 两页的示例代码用的都是 `model="deepseek-flash"`。
> 实测两个模型都会返回 `reasoning_content`,且 `usage.completion_tokens_details.reasoning_tokens`
> 能占满 `max_tokens`。差别只在思考开销大小,不在有没有。

关于 `CHROMA_LLM_MAX_TOKENS`:思考阶段与最终输出**共享**这个预算,给太小会出现「content 为空 + `finish_reason=length`」。代码遇到这种情况会抛 `BudgetExhaustedError` 并提示调大该值,而不是静默降级成「用户没提参数」(否则用户按了「确认」会被反问一句「先说说想要什么效果」)。

实测本项目抽取 prompt(`deepseek-flash`,`max_tokens=2000`):简单描述 ≈130 token / 1.5s,多参数描述 ≈280 / 1.6s,长段口语 ≈420 / 2.3s —— **2000 余量充足**。(参考:只有明确需要复杂推理的输入才会把预算吃光,那种情况下 2000 同样不够。)

可用 `extra_body={"thinking": {"type": "disabled"}}` 关掉思考,实测省约一半延迟与 token;本项目未启用,以保留抽取质量。

> 三个实测约束(改这块前请先看):
> 1. **不要传 `tool_choice`**。服务端对 `"required"` 或指定函数一律 400,文案是 `Thinking mode does not support this tool_choice` —— 但**这与模型无关**,是路由层写死的报文。`"auto"` 或省略都可以。
> 2. **思考模式忽略 `temperature`/`presence_penalty`/`frequency_penalty`**,设了不报错但无效(`top_p` 仅在思考模式生效,且下限被抬到 0.95)。所以别指望调温度来稳定输出的幅度标定。
> 3. **`strict=true` 不可用**。官方要求 strict 模式下「所有属性都必须列为 `required`」,而本项目刻意让未提及的字段可省略(避免默认值污染),两者结构性冲突 —— 实测 `/beta` + `strict` 报 `Required properties must match all properties in the object`。另外 `/chat/completions` 端点会**静默接受并忽略** `strict`,别被「没报错」骗了。因此校验走客户端 pydantic(`ExtractResult` 用 `extra="forbid"`,模型编造字段会判非法而非被静默丢弃)。

### HTTP 层的两个坑

- **超时必须显式设置。** `openai` SDK 默认 read timeout 是 **600 秒**、`max_retries=2`,最坏情况一次抽取阻塞约 30 分钟(官方也把 30 分钟列为非流式请求的响应时间上限)。本项目显式设为 30 秒 + 重试 1 次,实测抽取耗时 1~2.3 秒。
- **带 `tools` 的请求,`reasoning_content` 必须回传。** 官方文档明确:带 `tools` 参数时,后续请求要把历史轮次的 `reasoning_content` 完整传回,否则 API 返回 400。本项目每次抽取都是独立单轮请求(历史以文本形式拼进 user 消息,不伪装成多轮 message),因此不受该约束 —— **如果以后改成真正的多轮 messages,必须同时实现 `reasoning_content` 回传**,否则会 400。

### MySQL

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `MYSQL_HOST` | 主机 | `localhost` |
| `MYSQL_PORT` | 端口 | `3306` |
| `MYSQL_USER` | 用户 | `root` |
| `MYSQL_PASSWORD` | 密码 | `123456` |
| `MYSQL_DATABASE` | 数据库 | `chroma` |

### 认证

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `CHROMA_JWT_SECRET` | JWT 签名密钥,至少 32 字符 | 未配置则生成开发密钥写入 `.jwt_secret`(已入 .gitignore) |
| `CHROMA_ENV` | 设为 `production` 时强制要求显式配置密钥 | 空(开发模式) |

登录态存在 httpOnly cookie 中,前端不持有 token;退出登录通过递增 `users.token_version` 使该用户已签发的 token 全部失效。

限流有两套,口径不同:

| 范围 | 维度 | 阈值 | 超限 |
|---|---|---|---|
| 登录 | 按 IP | 5 次失败 / 5 分钟 | 429 |
| 注册 | 按 IP | 5 次尝试 / 5 分钟 | 429 + `Retry-After` |
| **AI 自动修图** | **按用户** | **20 次 / 小时** | 429 + `Retry-After` |

自动修图按用户而非 IP：正常运行可能包含模型调用和图像计算，登录用户换 IP 不能绕过配额。没有可写字段时跳过相应模型调用；参数校验失败的请求不消耗配额。

密钥规则:

- `.env.example` 里的占位值会被**拒绝启动**,必须换成随机串:`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- 未配置密钥时,开发模式会生成一份存到 `.jwt_secret`(权限 0600)并复用,避免重启即掉登录态、以及多 worker 各自持不同密钥导致互相验不过 token
- `CHROMA_ENV=production` 下不配置密钥直接报错启动失败

> 登录保留进程内的 IP 失败限制，并增加 MySQL 中按 IP 的原子尝试限制；注册和自动修图配额也在 MySQL 事务中预留，跨 worker 共享。成功登录只释放本次预留，不清除之前的失败尝试。

## 使用说明

1. **创建或恢复工作区**：登录后进入生成页。本机有效草稿优先恢复；新工作区使用独立身份并默认“保留氛围”。切换旧会话时，没有本机草稿才从最后一份生成参数恢复，旧参数来源需要确认。
2. **选择目标与输入**：“保留氛围”基础校正不主动改曝光、冷暖和绿洋红；“自然校正”按测量问题处理；“只调整风格”跳过基础校正和规则兜底，需要填写风格描述。普通对话无需照片，但不代表已验证图像效果。
3. **上传并确认样张**：最多 5 张，首张成为 AI 主样张。逐张确认照片实际 Photo Style；V-Log 必须是未经显示转换的 V-Log/V-Gamut 帧。输入不匹配的图片暂停试套，不会被重新解释为当前 LUT 输入。点击缩略图只换查看图，“设为主样张”才改变 AI 分析来源。
4. **保护参数并调整**：锁定单项或整组后控件禁用，RGB 各字段整体保护。选择本次手调与对话用途，再描述风格或调整滑杆。模型或规则提议触碰锁时整体拒绝该阶段；载入资产和恢复版本的冲突需要取消或明确解除冲突项保护。
5. **运行 AI 自动修图**：使用兼容主样张的原文件和当前完整参数。基础校正使用增量，风格阶段使用绝对目标；所有提议经过范围、锁与图像风险检查。运行中冻结编辑。报告区分目标完成情况与模型/规则执行情况，手调后旧报告标为此前调整。开启视觉复核会向模型发送照片与调色预览；关闭时仅发送统计数据。
6. **撤销、复位与验证**：一次滑杆手势或自动修图是一条操作，可撤销/重做。复位只取消未保护字段的调整及其来源贡献。点击“验证当前效果”在多图上比较技术基线和同一份当前 LUT，不调用模型；参数、图片或输入变化后需要重新验证。“暂未发现新增风险”不代表艺术质量合格。
7. **保存风格或完整效果**：保存面板中，`full_snapshot` 保存当前全部参数及单张校正；`portable_style` 保存实际生效的风格贡献和依赖，用于在另一工作区当前效果上追加。候选预览与保存均不改变草稿。来源未知、输入待确认或没有有效风格贡献时，只能先保存完整效果。再次追加同一修订前会提醒效果累积。
8. **保存与比较版本**：每个工作区最多 20 个命名版本。A、B 可选账号版本或当前草稿快照，选择后固定；继续编辑不会自动刷新快照。两版使用同一兼容样张，比较不改草稿或 AI 主图；“恢复到草稿”才应用完整参数与来源，保持当前锁，冲突需确认，并可撤销。
9. **下载与资产管理**：生成页直接下载烘焙当前完整效果；“我的 LUT”完整效果下载已保存参数，可复用风格下载前确认使用同输入中性参数。若要携带当前校正，先把风格载入工作区再直接下载。资产更新保留旧修订，历史修订可先预览再应用。
10. **会话与来源**：新客户端的聊天与自动修图关联当前工作区，不强制切换到固定自动会话。删除聊天会话会保留工作区、版本和风格资产；旧客户端的固定自动会话与旧报告仍兼容。

机内版文件主名固定为 8 位 ASCII，使用时相机 Photo Style 必须匹配 LUT 基准。后期版去掉机内标签，文件名和标题注明输入输出信号，同样需要匹配输入。兼容条件见[松下 Real Time LUT 指南](https://www.panasonic.com/uk/consumer/cameras-camcorders/lumix-expert-advice-learn/lumix-expert-advice/using-real-time-luts.html)与[松下 LUT 导入说明](https://av.jpn.support.panasonic.com/support/dsc/download/lut/index.html)。

### 保存位置与照片边界

| 内容 | 保存位置 | 刷新与跨设备行为 |
|---|---|---|
| 草稿、目标、锁、来源、最近 100 条历史、样张引用与查看状态 | 当前账号在本机浏览器的 IndexedDB | 同浏览器可恢复；不做云端草稿同步；展示形式、分割位置、选中样张和冻结 A/B 单独作为元数据恢复 |
| 可选缩小样张预览 | 本机 IndexedDB，默认关闭 | 单工作区合计最多 24MB，7 天过期；关闭选项清除缓存 |
| 原照片文件 | 当前页面内存 | 刷新后需重新选择；同一文件摘要才重新绑定原样张 |
| 工作区身份、聊天、命名版本、资产及修订、报告与统计摘要 | 账号数据库 | 同账号可查询；不包含照片像素 |
| 参数组展开状态与临时输入 | 当前页面内存 | 刷新后重新建立，不进入编辑历史 |

恢复了缩小预览后可以继续预览和做统计验证；自动修图仍需绑定原文件。本机缓存是缩小并重新编码的显示预览，重新绑定已记录的来源文件可确保分析的是该主样张的已确认来源。服务器仅在请求中解码和计算图片，不持久化照片。本机缓存不承诺对共享操作系统账号进行加密隔离。

### 工作区 API

接口使用现有登录 cookie，工作区元数据独立于 34 项调色参数。完整请求与响应说明见[调色工作区接口契约](docs/specs/style-workspace-design.md#93-实际-api)。

| 职责 | 当前入口 |
|---|---|
| 工作区身份 | `/api/workspaces` 与 `/api/workspaces/{workspace_id}` |
| 对话与自动修图 | `POST /api/session/chat`、`POST /api/auto/grade`；可携带工作区、创作上下文与主样张来源 |
| 自动修图作业 | `POST /api/auto/jobs` 创建，`GET /api/auto/jobs/{id}` 查询真实阶段，`DELETE` 请求取消 |
| 命名版本 | `/api/workspaces/{workspace_id}/versions`；支持创建、查询、改名、删除与显式恢复候选 |
| 多样张统计 | `POST /api/workspaces/{workspace_id}/validate`、`GET /api/workspaces/{workspace_id}/validation` |
| 资产应用与修订 | `/api/luts/{id}/apply`、`/apply-validated`、`/revisions` |
| 资产组织与检索 | `GET /api/luts` 支持查询筛选排序，`GET /api/luts/summary` 提供总数与分组，`PATCH /api/luts/{id}/metadata` 编辑信息 |
| 明确目标导出 | `GET /api/luts/{id}/download` 下载保存效果或 `neutral` 风格；`POST` 提交 `target: "current"` 和当前完整参数 |

自动修图作业注册表保存在服务进程内，当前部署须使用 **单个 Uvicorn worker**（项目的 `make dev` 已采用此方式）。每账号最多一个、全局最多两个活跃作业，进程内终态保留 15 分钟；正式保存的成功结果可按作业 UUID 从账号报告恢复，尚在运行的任务不支持服务重启续跑。未知请求须明确阻止迟到登记后才解除冻结，拒绝回执仍属于当前进程的状态。数据库限流仍跨进程共享，但这不意味着作业状态可以跨进程查询。多 worker 或多实例部署前需将作业状态、幂等标识与取消信号迁移到共享存储。

## 松下相机适配说明

- 输出 `.cube` 3D LUT(33 点),机内版注入 `#LUMIXPHOTOSTYLE` 头信息
- Standard/Natural/Vivid 走相同的 sRGB 相对调色曲线，输入必须是对应 Photo Style 的照片信号；它们尚未针对各风格做设备校准。V-Log 走 V-Log/V-Gamut 解码 → 线性域曝光和白平衡 → 简化显示映射 → Rec.709 编码
- 冷暖滑杆是以 6500K 为参考的相对 RGB 增益，不测量拍摄色温。风格强度不衰减曝光、白平衡或 V-Log 显示转换。旧预设因影调公式变更，在重新导出前应预览
- 机内烧录(Real-Time LUT)支持 S5M2 / S5M2X / G9M2;S5 / GH6 等仅机内监视

## 测试

```bash
make test           # 后端测试(pytest)
make test-frontend  # 前端展示层纯函数测试(Node 内置 runner,零依赖)
make test-parity    # 前后端一致性校验(引擎数学 + .cube 序列化)
make check          # 上面三个一起跑(提交前应全绿)
make build          # 构建前端产物到 frontend/dist
make admin          # 创建/重置本地账号
```

> **测试跑在独立数据库 `chroma_test` 上,不会碰你的开发库。**
>
> 这不是可有可无的整洁习惯:测试里有多个 `autouse` fixture 会执行
> `DELETE FROM users` / 清空 LUT 与会话。此前它们直接作用在开发库上 ——
> 跑一次 `make check` 就会把你的账号删掉,再登录自然失败。
> 现在 `backend/conftest.py` 会在**导入 storage.db 之前**把库名覆盖成
> `chroma_test`,并在不匹配时直接拒绝启动测试。
>
> 想改测试库名:`CHROMA_TEST_DATABASE=别的名字 make test`。
> 若把它配成 `chroma`,conftest 会报错退出而不是照常删数据。
>
> 另外 `db.clear_users()` / `clear_all()` / `clear_sessions()` 在开发库上会**直接
> 拒绝执行**(抛 `RuntimeError`)—— 因为临时脚本、REPL 这些路径不经过 pytest,
> 光靠 conftest 挡不住。确实需要重置本地环境时显式放行:
> `CHROMA_ALLOW_CLEAR_DEV_DB=1 <你的命令>`。

后端测试覆盖:LUT 引擎数学正确性、`.cube` 序列化、API CRUD、认证与限流、生成结果留档、会话流程与参数契约、tool calling 提取(含预算耗尽/入参非法等异常路径)、影调分区与分离色调、自动修图(测量/判定/渲染/编排/硬校验/API),以及**架构约束**的自动检查(分层依赖、参数集三方一致)。LLM 路径全部用桩,不打真实 API。

前端测试：`npm test` 覆盖展示、工作区事务、草稿存储、风格配方与接线辅助纯函数。

配方跨运行时回归可单独运行，跳过数据库测试配置：

```bash
PYTHONPATH=backend .venv/bin/python -m pytest --noconftest -p no:cacheprovider backend/tests/test_recipe_parity.py -q
```

2026-10-10 六项工作区能力的先前验证记录：一轮 `make check` 通过 804 项后端测试、61 项前端测试、21 组引擎参数的 7,875 个通道采样，以及 11 组 `.cube` 的 1,185,921 个数值比较；之后受影响后端回归 284 项通过，自动修图接口回归 40 项、前端纯函数 75 项通过，前端生产构建成功。

同日后续使用完善的最终完整 `make check`：**894 项后端、109 项前端、21 组引擎与 11 组 `.cube` 全部通过**，生产构建成功。新增输入引导、诊断、资产组织和作业控制的浏览器流程及独立复核结果见[本轮验收记录](docs/specs/product-readiness-validation.md)。

同日图像与调色扩展的最终完整 `make check`：**1,020 项后端、141 项前端、25 组引擎（9,375 个通道采样）与 15 组 `.cube`（1,617,165 个数值）全部通过**，生产构建成功。统一色彩管理、刷新作业恢复、参考匹配、外部 LUT、自由曲线及原分辨率照片导出的浏览器验收与使用边界见[扩展验收记录](docs/specs/extended-grading-validation.md)。

浏览器使用真实 JPEG 验证了正常调色预览、本机缩小预览恢复、原文件重新绑定、双样张统计、参数保护、撤销/重做和固定 A/B；另验证跨标签冲突另存副本、全参数保护时自动修图跳过、风格候选不改稿与重复追加取消、版本恢复后撤销，以及 STD 的 33³ 机内文件下载。390px 手机布局已验证两幅比较预览尺寸一致、滑动裁切正确且无横向溢出；撤销当前草稿后，冻结 A/B 的参数差异仍保持正确。模型约束与失败路径使用模拟响应覆盖；本轮没有现场重测真实模型生成的艺术效果，因此上述验证不代表对风格审美的验收。

前后端各有一份同数学的引擎实现(后端 numpy 用于产出 `.cube`,前端 JS 用于 WebGL 实时预览、缩略图与未保存时的直接下载),因此有三道一致性校验:

| 校验 | 内容 | 判定标准 |
|---|---|---|
| `check_parity.mjs` | 引擎数学 | 125 个采样点 × 25 组参数,逐点差 < 1e-6 |
| `check_cube_parity.mjs` | `.cube` 序列化 | header 与行数逐字节相同;数值差异 ≤ 6 位小数下 1 个最低位 |
| `test_photo_render.py` | LUT 采样语义 | Python 渲染与前端 GLSL 公式逐点一致(< 1e-5) |

第三道是自动修图引入的:模型看的是后端渲染的图,用户看的是前端渲染的图,**两者必须一致**,否则视觉复检的结论对不上用户所见。

`.cube` 序列化的已知差异:后端 `f"{v:.6f}"` 用 Python 的 round-half-even,前端 `toFixed` 用 half-away-from-zero,叠加 JS `Math.pow` 与 numpy 的浮点差。当前 15 组用例中 identity、暖调相机和基础软件输出**逐字节相同**；含 V-Log、gamma、曲线或外部 LUT 的路径最多差 1 个最低位，差异占比最高约 2.02%。**改动任一侧的算子或序列化后都要跑 `make check`。**

## 文档

| 文档 | 内容 |
|---|---|
| [docs/auto-retouch.md](docs/auto-retouch.md) | AI 自动修图总览与范围边界 |
| [docs/specs/architecture.md](docs/specs/architecture.md) | 分层职责、关键取舍、成本预算、风险 |
| [docs/lut-design-remediation.md](docs/lut-design-remediation.md) | LUT 参数设计问题、修订任务、验收与设备校准限制 |
| [docs/specs/technical.md](docs/specs/technical.md) | 接口签名、数据结构、阈值常量、精度包络、API 契约 |
| [docs/specs/ui-design.md](docs/specs/ui-design.md) | 线框、组件规格、状态机、完整微文案 |
| [docs/specs/style-workspace-design.md](docs/specs/style-workspace-design.md) | 已实现的六项工作区能力：用户流程、保存边界、参数/配方契约、实际 API 与验收记录 |
| [docs/specs/product-readiness-design.md](docs/specs/product-readiness-design.md) | 输入引导、调色诊断、资产组织与 AI 过程控制的设计与范围 |
| [docs/specs/product-readiness-validation.md](docs/specs/product-readiness-validation.md) | 本轮完成清单、完整回归、浏览器与独立复核结果、部署边界和延期事项 |
| [docs/specs/extended-grading-design.md](docs/specs/extended-grading-design.md) | 色彩管理、作业恢复、参考匹配、外部 LUT、自由曲线与照片导出的设计及参数契约 |
| [docs/specs/extended-grading-validation.md](docs/specs/extended-grading-validation.md) | 扩展功能交付、1,020 项后端与 141 项前端回归、浏览器验收、复核修复及待办 |
| [docs/specs/test-plan.md](docs/specs/test-plan.md) | 测试分层、合成样张、硬校验断言 |
| [docs/leftover-issues.md](docs/leftover-issues.md) | 已知问题的记录与处理结果 |
