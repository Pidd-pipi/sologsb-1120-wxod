# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test}.ts
        ├── stores/{clock,part,step,merge}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge}.vue
        ├── hooks/{useClockSearch,useRepairProgress}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,TestView,MergePage}.vue
        └── utils/{db,timeCalc,id,merge}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：左侧机芯信息，右侧工序流与走时测试记录，可切零件清单 | Clock、RepairStep、TimekeepingTest、MovementPart |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/tests/:clockId` | 走时测试录入与多方位均值计算，生成走时单文本 | TimekeepingTest |
| `/merge` | 档案合并：导出/导入离线档案包，按藏品号认领、合并工序与零件、列清差异后写入，失败可重试 | ArchivePackage、MergeResult |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 四张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：为工序补充 `invalid` / `invalidReason` 失效标记（合并功能使用）。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序与 1 次走时测试。

## 档案合并（两台平板离线回店）

两台平板各自离线记录后回店，可通过「档案合并」页（`/merge`）把两边数据合到同一份档案，不再整份覆盖。

- **导出档案包**：在合并页填写设备名称与操作人，导出含来源标记（`source`）的 JSON 档案包。
- **导入预览**：可一次多选两边的档案包，系统先列出差异与变更，**确认前不动原档**。
- **按藏品号认领**：同一台钟以 `clockNo` 认领，不新增重复钟表；底库已有字段不覆盖，仅补齐空字段。
- **工序合并**：两边新增的工序都保留各自操作人与顺序，合并后按 `startedAt` 稳定重排为连续顺序号（不跳号）。
- **零件决定变更 → 工序失效**：同一件零件（按「钟表 + 名称 + 装配位置」匹配）若处理决定相对底库改变，关联到该零件的维修工序即标记为「已失效」，并按合并后数据重算顺序。
- **差异列清**：缺钟表、缺零件、旧档案没有来源标记时分别列为错误（红色，阻止写入）或提醒（橙色）。
- **写入失败可重试**：写入前把两边的包与合并结果暂存到 `localStorage`；写入失败保留两边的包，页面提供「重试写入」，下次打开也会提示继续。
- 写入为单事务（`db.transaction`），任一页失败整体回滚，不会出现半写状态。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本，可复制或下载 txt。
- **档案合并**：两台平板离线回店后，按藏品号认领同一台钟，合并两边工序（保留操作人与顺序）、零件与走时测试；零件决定变更则关联工序失效并重算顺序；缺件/缺钟/无来源标记先列差异，确认后才写入，失败保留包可重试。
