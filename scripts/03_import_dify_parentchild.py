# -*- coding: utf-8 -*-
"""
《中华本草》文本导入 Dify 知识库（父子分段模式）
================================================

分段配置（与 Dify 界面设置一一对应）：
  父块（用作上下文）：
    - 模式：段落 (parent_mode=paragraph)
    - 分段标识符：\n#   （行首 # 即药材条目）
    - 分段最大长度：1400
  子块（用于检索）：
    - 分段标识符：留空 ""（按字符长度自动切分父块内部文本）
    - 分段最大长度：420
    - 子块重叠：70
  文本预处理规则：两个复选框均不勾选
    （勾选 remove_extra_spaces 会把文本里的换行抹掉，导致 \n# 分隔符失效、
      药材条目切不开 —— 这是实际踩过的坑，清洗务必在导入前自己完成）

凭据一律通过环境变量注入，不落盘：
    DIFY_BASE_URL      如 http://<your-dify-host>/v1
    DIFY_API_KEY       如 dataset-xxxx
    DIFY_DATASET_ID    知识库数据集ID
"""

import os
import glob
import requests

# ====== 配置（从环境变量读取） ======
API_BASE_URL = os.environ.get("DIFY_BASE_URL", "http://127.0.0.1:6601/v1")
API_KEY = os.environ.get("DIFY_API_KEY", "dataset-your-api-key")
DATASET_ID = os.environ.get("DIFY_DATASET_ID", "your-dataset-id")
# ===================================

INPUT_DIR = os.environ.get("INPUT_DIR", "./cleaned")


def create_by_text(file_path):
    """通过文本创建文档（替代文件上传）"""
    filename = os.path.basename(file_path)
    url = f"{API_BASE_URL}/datasets/{DATASET_ID}/document/create-by-text"

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()

    payload = {
        "name": filename,
        "text": text,
        "indexing_technique": "high_quality",
        "doc_form": "hierarchical_model",
        "doc_language": "Chinese",
        "process_rule": {
            "mode": "hierarchical",
            "rules": {
                # ===== 父块（用作上下文）=====
                "parent_mode": "paragraph",
                "segmentation": {
                    "separator": "\n#",        # 分段标识符：\n#（行首 # = 药材条目）
                    "max_tokens": 1400,        # 分段最大长度
                },
                # ===== 子块（用于检索）=====
                "subchunk_segmentation": {
                    "separator": "",           # 分段标识符留空 → 按字符长度自动切分
                    "max_tokens": 420,         # 分段最大长度
                    "chunk_overlap": 70,       # 子块重叠
                },
                # ===== 文本预处理规则：全部不勾选 =====
                "pre_processing_rules": [
                    {"id": "remove_extra_spaces", "enabled": False},
                    {"id": "remove_urls_emails", "enabled": False},
                ],
            },
        },
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=60)

    if resp.status_code == 200:
        result = resp.json()
        doc = result.get("document", {})
        print(f"  [成功] {filename} -> document_id={doc.get('id')}, batch={result.get('batch')}")
        return result.get("batch")
    else:
        print(f"  [失败] {filename} -> HTTP {resp.status_code}: {resp.text}")
        return None


def main():
    txt_files = sorted(glob.glob(os.path.join(INPUT_DIR, "*.txt")))
    if not txt_files:
        print(f"未找到 txt 文件: {INPUT_DIR}")
        return

    print(f"共找到 {len(txt_files)} 个文件，开始上传...\n")

    batches = []
    for i, file_path in enumerate(txt_files, 1):
        print(f"[{i}/{len(txt_files)}] 上传: {os.path.basename(file_path)}")
        batch = create_by_text(file_path)
        if batch:
            batches.append((os.path.basename(file_path), batch))

    print(f"\n上传完成: 成功 {len(batches)}/{len(txt_files)}")
    if batches:
        print("\n批次ID列表（可用于查询索引进度）:")
        for name, batch in batches:
            print(f"  {name}: {batch}")


if __name__ == "__main__":
    main()
