#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF 逐页 OCR 脚本
=================
遍历文件夹全部PDF，从PDF文件逐页渲染图片（200 DPI），使用视觉模型
（file_parse 接口，MinerU 后端）识别文字，将每页识别结果输出为独立
txt 文件，文件名为"书名_第X页.txt"。

特性:
  1. 断点续跑 —— 已存在且非空的页文件自动跳过，中断后可直接重跑
  2. HTML 表格"向上填充"修复 —— 处理古籍表格中用引号表示"同上"的情况
  3. 页数可控 —— --all 全部页 / --pages N 每本书前N页

用法:
    python 01_pdf_page_ocr.py                  # 每本书默认只跑前10页
    python 01_pdf_page_ocr.py --all            # 每本书跑全部页
    python 01_pdf_page_ocr.py --pages 20       # 每本书跑前20页
"""

import io
import os
import re
import sys
import time
import argparse

import pymupdf
import requests
from bs4 import BeautifulSoup


# ============ PDF存放文件夹 ============
PDF_ROOT_FOLDER = os.environ.get("PDF_ROOT_FOLDER", "./pdf")

# ============ file_parse 服务（视觉模型 OCR，MinerU 后端） ============
FILE_PARSE_URL = os.environ.get("FILE_PARSE_URL", "http://127.0.0.1:8020/file_parse")

# ============ PDF渲染DPI（越高越清晰，但越慢） ============
RENDER_DPI = 200


def log(msg):
    """打印带时间戳的日志"""
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def get_book_name(pdf_path):
    """从PDF文件路径提取书名（不含扩展名）"""
    return os.path.splitext(os.path.basename(pdf_path))[0]


def render_page_to_png(page, dpi=RENDER_DPI):
    """用PyMuPDF将PDF页面渲染为PNG图片字节"""
    zoom = dpi / 72.0
    mat = pymupdf.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")
    return img_bytes, "image/png"


def call_file_parse(img_bytes, content_type="image/png"):
    """上传图片字节到file_parse接口，返回识别的markdown文本"""
    data = {
        "return_middle_json": "false",
        "return_model_output": "false",
        "return_md": "true",
        "return_images": "false",
        "end_page_id": "99999",
        "parse_method": "auto",
        "start_page_id": "0",
        "lang_list": "ch",
        "server_url": "string",
        "return_content_list": "false",
        "backend": "hybrid-auto-engine",
        "table_enable": "true",
        "response_format_zip": "false",
        "return_original_file": "false",
        "formula_enable": "true",
    }
    headers = {"accept": "application/json"}
    files = {"files": ("image.png", img_bytes, content_type)}
    resp = requests.post(FILE_PARSE_URL, headers=headers, data=data, files=files, timeout=300)
    resp.raise_for_status()

    result = resp.json()
    for v in result.get("results", {}).values():
        return v.get("md_content", "")
    return ""


def _extract_suffix(text: str) -> str:
    """提取文本末尾的括号后缀，例如 '石刀(商家文化)' -> '(商家文化)'；无则返回空串。
    支持中英文括号。
    """
    m = re.search(r"[（(][^（）()]*[）)]\s*$", text)
    return m.group(0) if m else ""


def _is_only_mark(text: str, mark: str) -> bool:
    """判断单元格是否【仅由引号和空白组成】，例如 '"' 、'" "' 、' " " '"""
    if not text:
        return False
    cleaned = text.replace(mark, "").strip()
    return cleaned == ""


def fix_table_fill_up(html: str, suffix_mark: str = '"') -> str:
    """
    HTML表格向上填充修复
    - 单元格【仅引号】：完整引用上一个单元格内容
    - 单元格【前缀+引号】(如 石斧")：保留前缀，仅把上一个单元格的括号后缀补上
    - 正常文本：更新本列有效值
    :param html: 原始html文本
    :param suffix_mark: 重复标记符号，默认双引号 "
    :return: 修复完成后的完整HTML
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    if not table:
        return html

    rows = table.find_all("tr")
    last_valid_col = dict()

    for tr in rows:
        tds = tr.find_all("td")
        for col_idx, td in enumerate(tds):
            raw_text = td.get_text(strip=False)
            text = raw_text.strip()

            if col_idx in last_valid_col:
                prev_text = last_valid_col[col_idx]

                if _is_only_mark(text, suffix_mark):
                    td.string = prev_text
                elif suffix_mark in text:
                    prefix = text.replace(suffix_mark, "").strip()
                    suffix = _extract_suffix(prev_text)
                    td.string = prefix + suffix
                    last_valid_col[col_idx] = td.string
                else:
                    last_valid_col[col_idx] = raw_text
            else:
                if not _is_only_mark(text, suffix_mark) and suffix_mark not in text:
                    last_valid_col[col_idx] = raw_text
    return str(soup)


def process_one_pdf(pdf_path, args):
    """处理单本PDF文件，返回本本书成功/失败/跳过计数"""
    book_name = get_book_name(pdf_path)
    log(f"\n>>>>>>>>>> 开始处理书籍：{book_name} <<<<<<<<<<")

    # 每本书输出独立文件夹
    out_dir = os.path.join(PDF_ROOT_FOLDER, f"{book_name}_识别结果")
    os.makedirs(out_dir, exist_ok=True)
    log(f"本书输出目录: {out_dir}")

    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)
    log(f"本书PDF总页数: {total_pages}")

    # 确定本书处理页数
    if args.all:
        max_pages = 0
    else:
        max_pages = args.pages

    if max_pages == 0 or max_pages > total_pages:
        pages_to_process = total_pages
    else:
        pages_to_process = max_pages
    log(f"本书本次将处理: {pages_to_process} 页")

    success_count = 0
    fail_count = 0
    skip_count = 0

    for page_idx in range(pages_to_process):
        page_num = page_idx + 1
        txt_filename = f"{book_name}_第{page_num}页.txt"
        txt_path = os.path.join(out_dir, txt_filename)

        # 断点续跑：已存在且非空则跳过
        if os.path.isfile(txt_path) and os.path.getsize(txt_path) > 0:
            log(f"  [{page_num}/{pages_to_process}] 已存在，跳过: {txt_filename}")
            skip_count += 1
            continue

        try:
            page = doc[page_idx]
            img_bytes, content_type = render_page_to_png(page)
            log(f"  [{page_num}/{pages_to_process}] 识别中 (图片大小: {len(img_bytes)//1024}KB)...")
            text = call_file_parse(img_bytes, content_type)

            if not text or not text.strip():
                raise ValueError("模型返回空文本")

            text = fix_table_fill_up(text)

            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text)

            log(f"  [{page_num}/{pages_to_process}] 识别成功，文本长度: {len(text)} -> {txt_filename}")
            success_count += 1
        except Exception as e:
            log(f"  [{page_num}/{pages_to_process}] 识别失败: {e}")
            fail_count += 1

    doc.close()
    log(f"--------【{book_name}】处理结束：成功 {success_count}，失败 {fail_count}，跳过 {skip_count} --------")
    return success_count, fail_count, skip_count


def main():
    parser = argparse.ArgumentParser(description="批量PDF文字识别脚本")
    parser.add_argument("--all", action="store_true", help="处理全部PDF的全部页")
    parser.add_argument("--pages", type=int, default=10, help="每本书处理前N页（默认10）")
    args = parser.parse_args()

    # 扫描文件夹全部pdf
    all_pdf_files = []
    for fname in os.listdir(PDF_ROOT_FOLDER):
        if fname.lower().endswith(".pdf"):
            fullpath = os.path.join(PDF_ROOT_FOLDER, fname)
            all_pdf_files.append(fullpath)
    all_pdf_files.sort()

    if len(all_pdf_files) == 0:
        log(f"错误：文件夹 {PDF_ROOT_FOLDER} 没有找到PDF文件！")
        sys.exit(1)

    log(f"一共检测到 {len(all_pdf_files)} 个PDF文件：")
    for p in all_pdf_files:
        log(f" - {os.path.basename(p)}")

    total_success = 0
    total_fail = 0
    total_skip = 0

    for pdf_file in all_pdf_files:
        s, f, sk = process_one_pdf(pdf_file, args)
        total_success += s
        total_fail += f
        total_skip += sk

    log("\n" + "=" * 60)
    log(f"【全部任务结束】总成功:{total_success} 总失败:{total_fail} 总跳过:{total_skip}")
    log(f"所有识别结果子目录输出在：{PDF_ROOT_FOLDER}")


if __name__ == "__main__":
    main()
