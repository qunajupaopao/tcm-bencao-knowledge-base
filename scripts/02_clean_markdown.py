# -*- coding: utf-8 -*-
"""
识别结果文本清洗
=================
对 OCR 识别输出的 markdown 文本做轻度清洗，为知识库导入做准备：
  1. 删除图片链接 ![]()
  2. 删除 <details>...</details> 图片块
  3. 把3个及以上换行压缩为2个换行，保留 # 标题前的换行
     （标题 # 是后续"父子分段"按药材条目切分的分隔标识，必须保留）

注意：不要依赖 Dify 的 remove_extra_spaces 预处理规则做这件事——
它会抹掉换行，导致 \n# 分隔符失效、药材条目切不开。

用法:
    python 02_clean_markdown.py <input_dir> <output_dir>
    python 02_clean_markdown.py ./识别结果 ./cleaned
"""

import os
import re
import sys


def clean_zhbencao_text(text):
    # 删除图片链接 ![]()
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    # 删除 <details>...</details> 图片块
    text = re.sub(r'<details>[\s\S]*?</details>', '', text)
    # 把3个及以上换行压缩为2个换行，保留#标题前面换行
    text = re.sub(r'\n{3,}', r'\n\n', text)
    return text


def batch_clean_txt(input_dir, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    for fname in os.listdir(input_dir):
        if not fname.endswith(".txt"):
            continue
        path_in = os.path.join(input_dir, fname)
        with open(path_in, 'r', encoding='utf-8') as f:
            raw = f.read()
        clean = clean_zhbencao_text(raw)
        path_out = os.path.join(output_dir, fname)
        with open(path_out, 'w', encoding='utf-8') as f:
            f.write(clean)
        print(f"已处理：{fname}")


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        input_folder, output_folder = sys.argv[1], sys.argv[2]
    else:
        input_folder = "./识别结果"
        output_folder = "./cleaned"
    batch_clean_txt(input_folder, output_folder)
    print("全部文件处理完毕！")
