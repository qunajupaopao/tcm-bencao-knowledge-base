# 中华本草智能问答知识库（中医智能问答系统 · 数据管线）

> ⚠️ **声明**：本项目为在校实习期间的开发实践。《中华本草》典籍数据与公司内部服务地址已脱敏：所有 API Key、数据集 ID、内网地址均以环境变量 / 占位符形式呈现，原始 PDF 与识别语料不在本仓库。前端问答应用部分为原型验证（Demo），**数据管线部分为完整工程实现**。

## 一、项目背景

把《中华本草》这类大型中医药典籍（多卷 PDF / 扫描件）转化为**可对话、可检索的 AI 知识库**：先逐页 OCR 数字化，再清洗、按药材条目结构化分段，导入 Dify 知识库（父子分段 + 向量检索），最终支撑中医智能问答应用。

## 二、技术栈

- **OCR / 文档数字化**：PyMuPDF（逐页渲染 200 DPI PNG）+ 视觉模型解析服务（MinerU 后端 `file_parse` 接口）
- **文本清洗**：Python 正则（去图片链接 / `<details>` 块、压缩多余换行）
- **知识库导入**：Dify Knowledge API（`hierarchical_model` 父子分段模式）
- **OCR 人工校对**：自研 Node.js 校对编辑器（服务端 `server.js` + 网页端）
- **问答应用**：Dify Agent 工作流 + Vue 前端（原型）

## 三、系统架构

```mermaid
flowchart LR
    A[中华本草 PDF / 多卷扫描件] --> B[逐页 OCR：PyMuPDF 渲染 200DPI + 视觉模型识别]
    B --> C[按页输出 markdown，支持断点续跑]
    C --> D[表格修复：HTML 向上填充算法]
    D --> E[文本清洗：去图片块 / 压缩换行]
    E --> F[人工校对：自研 OCR 校对编辑器]
    F --> G[Dify 父子分段导入：父块=药材条目 / 子块=检索切片]
    G --> H[向量索引]
    H --> I[智能体问答：Dify 工作流 + Vue 前端]
```

## 四、核心设计与踩坑记录

### 1. 逐页 OCR 与断点续跑（`01_pdf_page_ocr.py`）

- 遍历文件夹内全部 PDF，逐页用 PyMuPDF 渲染为 200 DPI PNG，上传视觉模型识别，**每页输出独立 txt**（`书名_第X页.txt`）；
- 支持参数控制页数（`--all` / `--pages 20`）；
- **断点续跑**：已存在且非空的页文件自动跳过，大批量处理中断后可直接重跑。

### 2. OCR 表格「同上」修复（`01_pdf_page_ocr.py`）

古籍表格里，下一行常用单个引号 `"` 表示「同上一格」。OCR 原样保留就会产生大量空值。实现**HTML 表格向上填充算法**：

- 单元格仅为引号 → 复制上一行同列的完整内容；
- 单元格为「前缀+引号」（如 `石斧"`）→ 保留前缀，仅补上一格的括号后缀；
- 正常文本 → 更新本列有效值。

### 3. Dify 父子分段导入（`03_import_dify_parentchild.py`）

《中华本草》按药材条目组织，每个条目以行首 `#` 开头。利用 Dify `hierarchical_model`（父子分段）实&#x73B0;**「按条目召回上下文、按切片精准检索」**：

| 层级      | 配置                                | 说明              |
| ------- | --------------------------------- | --------------- |
| 父块（上下文） | 分隔符 `\n#`，max_tokens 1400         | 一个父块 = 一个完整药材条目 |
| 子块（检索）  | 分隔符留空（按长度切分），max_tokens 420，重叠 70 | 短切片提升检索命中率      |

> **踩坑**：Dify 文本预处理规则里的 `remove_extra_spaces` 会把换行抹掉，导致 `\n#` 分隔符失效、药材条目切不开。解决办法：**全部预处理规则不勾选**，清洗工作自己在导入前完成。

### 4. 自研 OCR 人工校对编辑器（`ocr_review_server/server.js`）

视觉模型识别古籍无法 100% 准确，因此做了一个人工校对工具：

- Node.js 原生 `http` 服务，网页端对照页面整图逐块校对 OCR 文本；
- 覆盖文本存 `edits.json`（键：文档|页|块），逐条修改追加 `log.jsonl`；
- **「最初导入内容」快照**（`origins.json`）：只在首次出现时记录，后续修改不覆盖，统计「未修改文字数量」时以它为基准；
- 每次修改后自动重新生成可读的 `修改日志.md` 存档。

## 五、仓库结构

```text
├── README.md
├── requirements.txt
├── scripts/
│   ├── 01_pdf_page_ocr.py            # PDF 逐页 OCR + 表格修复 + 断点续跑
│   ├── 02_clean_markdown.py          # 识别结果清洗（去图片块/压缩换行）
│   ├── 03_import_dify_parentchild.py # Dify 父子分段批量导入
│   └── 04_get_process_rule.py        # 查询数据集分段配置（调试用）
└── ocr_review_server/
    └── server.js                     # OCR 人工校对编辑器服务端（前端页面未包含）
```

## 六、运行方式

```bash
pip install -r requirements.txt

# 1. PDF 逐页 OCR（服务地址用环境变量注入）
export FILE_PARSE_URL="http://<your-ocr-service>:8020/file_parse"
python scripts/01_pdf_page_ocr.py --pages 10     # 每本书先跑前10页
python scripts/01_pdf_page_ocr.py --all          # 全部页

# 2. 清洗识别结果
python scripts/02_clean_markdown.py

# 3. 导入 Dify 知识库（父子分段）
export DIFY_BASE_URL="http://<your-dify-host>/v1"
export DIFY_API_KEY="dataset-xxxx"
export DIFY_DATASET_ID="your-dataset-id"
python scripts/03_import_dify_parentchild.py
```

## 七、成果

- 打通「典籍 PDF → 逐页 OCR → 表格修复 → 清洗 → 人工校对 → 父子分段导入 → 向量检索问答」完整数据链路；
- 断点续跑 + 分页输出设计支撑大体量典籍的批量数字化；
- 父子分段策略让问答**既引用完整药材条目、又能精准命中检索片段**；
- 自研校对工具保障 OCR 语料质量，修改全程留痕可审计。
