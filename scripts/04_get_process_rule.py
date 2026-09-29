# -*- coding: utf-8 -*-
"""
查询 Dify 数据集分段配置（调试用）
==================================
获取知识库中第一条文档的 doc_form 与完整 process_rule 配置，
用于核对界面上的父子分段设置与 API 实际生效配置是否一致。

凭据一律通过环境变量注入：
    DIFY_BASE_URL / DIFY_API_KEY / DIFY_DATASET_ID
"""

import os
import requests
import json

API_BASE_URL = os.environ.get("DIFY_BASE_URL", "http://127.0.0.1:6601/v1")
API_KEY = os.environ.get("DIFY_API_KEY", "dataset-your-api-key")
DATASET_ID = os.environ.get("DIFY_DATASET_ID", "your-dataset-id")

headers = {
    "Authorization": f"Bearer {API_KEY}"
}

# 1.获取文档列表，拿到第一条文档id
resp = requests.get(f"{API_BASE_URL}/datasets/{DATASET_ID}/documents?limit=1", headers=headers)
data = resp.json()

if data.get("data"):
    doc_item = data["data"][0]
    doc_id = doc_item["id"]
    print("=== doc_form ===")
    print(doc_item["doc_form"])

    # 2.调用单文档详情接口获取process_rule
    resp_detail = requests.get(f"{API_BASE_URL}/datasets/{DATASET_ID}/documents/{doc_id}", headers=headers)
    detail_data = resp_detail.json()

    print("\n=== process_rule完整配置（复制全部）===")
    print(json.dumps(detail_data["process_rule"], ensure_ascii=False, indent=2))
else:
    print("数据集没有已上传文档")
