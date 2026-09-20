#!/usr/bin/env python3
"""Real local HTTP manual upload -> worker -> cited-question acceptance.

Creates its own loopback PostgreSQL instance, API process and test owner. No AI
provider is enabled. Credentials go only to a chmod-600 .private state file.
By default API/PG stay running for short-lived iOS simulator integration; use
--stop-state STATE when finished. --recheck-state restarts just this API to test
current server source against the same real imported manual.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PDF = ROOT / "SUZUKI GSX250R 维修手册中文版(1).pdf"
CHUNK_SIZE = 4 * 1024 * 1024
# Independently reviewed after the first real HTTP run. Do not alter the golden
# fixture or call an unrelated occurrence of a number an acceptable answer.
REVIEWED_SOURCE_SHA = "e9616014ff6c4b03cf4f072fff9180842383ea0798f4a84ba59d4b572a9e2bef"
REVIEWED_ALTERNATIVES = {
    "GSX-006": {"page": 148, "printedPage": "1D-9", "quote": "怠速\n当发动机暖机时\n[标准值]:1400 ± 100 r/min"},
    "GSX-017": {"page": 223, "printedPage": "1E-5", "quote": "发动机大修[标准值]:2400 ml"},
    "GSX-020": {"page": 255, "printedPage": "1G-4", "quote": "燃油压力\n[标准值]:289 – 299 kPa"},
}


def private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write("\n")
    os.chmod(path, 0o600)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def source_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as src:
        for chunk in iter(lambda: src.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def api(state: dict, method: str, path: str, body=None, raw=None, extra_headers=None, authenticated=True):
    headers = {}
    if authenticated:
        headers["Authorization"] = "Bearer " + state["token"]
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    else:
        data = raw
        if raw is not None:
            headers["Content-Type"] = "application/octet-stream"
    headers.update(extra_headers or {})
    request = Request(state["baseURL"] + path, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=120) as response:
            data = response.read()
            if response.headers.get("Content-Type", "").startswith("application/json"):
                data = json.loads(data)
            return response.status, data, dict(response.headers)
    except HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        # Server error payloads never contain the request Authorization header.
        raise RuntimeError(f"HTTP {exc.code} {method} {path}: {payload[:500]}") from exc


def process_env(state: dict) -> dict:
    env = dict(os.environ)
    # Explicitly erase inherited provider credentials so this run cannot spend AI tokens.
    env.update({"DATABASE_URL": state["databaseURL"], "DATA_DIR": state["dataDir"],
                "HOST": "127.0.0.1", "PORT": str(state["apiPort"]), "NODE_ENV": "test",
                "AI_BASE_URL": "", "AI_MODEL": "", "AI_API_KEY": "",
                "PYTHONPATH": str(ROOT / "worker")})
    return env


def start_api(state: dict) -> None:
    fingerprint = hashlib.sha256()
    for source in sorted((ROOT / "server/src").glob("*.ts")) + [ROOT / "server/schema.sql"]:
        fingerprint.update(source.name.encode() + b"\0" + source.read_bytes())
    state["serverSourceFingerprint"] = fingerprint.hexdigest()
    log_path = Path(state["privateDir"]) / "api.log"
    with log_path.open("ab") as log:
        proc = subprocess.Popen([state["node"], "--title=" + state["apiTitle"], "--import", "tsx", str(ROOT / "server/src/index.ts")], cwd=ROOT / "server", env=process_env(state), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    os.chmod(log_path, 0o600)
    state["apiPID"] = proc.pid
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError("Local API exited; inspect restricted api.log")
        try:
            if api(state, "GET", "/healthz", authenticated=False)[0] == 200:
                return
        except (URLError, RuntimeError, ConnectionError):
            pass
        time.sleep(.2)
    raise RuntimeError("Local API did not become healthy")


def stop_api(state: dict) -> None:
    pid = state.get("apiPID")
    if not pid:
        return
    actual = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout.strip()
    if actual and state["apiTitle"] not in actual:
        raise RuntimeError("Saved API PID no longer belongs to this test; refusing to signal it")
    if actual:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(.1)


def bootstrap(state: dict, owner_id=None) -> dict:
    env = process_env(state)
    if owner_id:
        env["OWNER_ID"] = owner_id
    else:
        env.pop("OWNER_ID", None)
    completed = subprocess.run([state["node"], "--import", "tsx", str(ROOT / "server/src/bootstrap.ts")], cwd=ROOT / "server", env=env, capture_output=True, text=True, check=True)
    # This captured stdout is a credential. Never forward it to terminal/logs.
    return json.loads(completed.stdout.strip().splitlines()[-1])


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value).replace("–", "-").replace("—", "-")).lower()


def score_question(question: dict, response: dict) -> dict:
    citations = response.get("citations", [])
    text = normalize("\n".join(c.get("quote", "") for c in citations))
    all_expected = question.get("expectedTerms", [])
    missing = [term for term in all_expected if normalize(term) not in text]
    expected_pages = question.get("expectedPages", [])
    page_hit = any(c.get("page") in expected_pages for c in citations)
    # Parameters are an additional recall signal, not proof of field-value association.
    parameters = re.findall(r"\d+(?:\.\d+)?(?:\s*[±–-]\s*\d+(?:\.\d+)?)?(?:\s*(?:N·m|r/min|kPa|mm|ml|mA|°C|km|V|L|A))?", question.get("expectedAnswer", ""))
    missing_parameters = [p for p in parameters if normalize(p) not in text]
    return {"id": question["id"], "question": question["question"], "expectedAnswer": question.get("expectedAnswer"),
            "expectedPages": expected_pages, "returnedPages": [c.get("page") for c in citations],
            "source": response.get("source"), "expectedPageHit": page_hit,
            "allExpectedTermsFound": not missing, "missingExpectedTerms": missing,
            "allParametersFound": not missing_parameters, "missingParameters": missing_parameters,
            "strictPass": page_hit and not missing, "response": response}


def validate_storage(state: dict, reference: Path | None) -> dict:
    """Check actual DB rows against worker sidecars and optional offline baseline."""
    code = """import json,sys,psycopg
args=json.load(sys.stdin)
with psycopg.connect(args['databaseURL']) as conn:
 with conn.cursor() as cur:
  cur.execute('SELECT page, printed_page, section, text, tokens, quality FROM manual_pages WHERE manual_id=%s ORDER BY page', (args['manualId'],))
  print(json.dumps(cur.fetchall(),ensure_ascii=False))
"""
    result = subprocess.run([state["python"], "-c", code], input=json.dumps({"databaseURL": state["databaseURL"], "manualId": state["manualId"]}), capture_output=True, text=True, check=True)
    rows = json.loads(result.stdout)
    fields = ["printedPage", "section", "text", "tokens", "quality"]
    page_dir = Path(state["dataDir"]) / "manuals" / state["manualId"] / "pages"
    actual_pages = {}
    differences = []
    for row in rows:
        page_record = json.loads((page_dir / f"{row[0]:04d}.json").read_text())
        actual_pages[row[0]] = page_record
        for index, field in enumerate(fields, start=1):
            if row[index] != page_record[field]:
                differences.append({"page": row[0], "field": field})
    contiguous = [row[0] for row in rows] == list(range(1, state["manualState"]["pageCount"] + 1))
    verified = {"databaseRows": len(rows), "contiguous": contiguous, "databaseSidecarDifferences": differences}
    if reference:
        baseline = [json.loads(line) for line in reference.read_text().splitlines() if line.strip()]
        changed = []
        for expected in baseline:
            actual = actual_pages.get(expected["page"])
            for field in fields:
                if actual is None or actual[field] != expected[field]:
                    changed.append({"page": expected["page"], "field": field})
        verified.update({"offlineReference": str(reference), "offlineReferenceSha256": source_sha(reference), "offlineReferencePages": len(baseline), "offlineDifferences": changed})
        assert len(baseline) == len(rows) and not changed, "Real import differs from offline reference"
    assert contiguous and not differences, "Database differs from real worker page sidecars"
    return verified


def query_fixtures(state: dict, fixture: Path, report_path: Path) -> dict:
    fixture_data = json.loads(fixture.read_text())
    assert fixture_data["sourceSha256"] == state["sourceSha256"], "Fixture is for a different source PDF"
    rows = []
    started = time.monotonic()
    for question in fixture_data["questions"]:
        if question["expectedBehavior"] != "cited_answer":
            continue
        status, response, headers = api(state, "POST", "/v1/manuals/ask", {"vehicleId": state["vehicleId"], "question": question["question"]})
        result = score_question(question, response)
        integrity = True
        for citation in response.get("citations", []):
            page_path = Path(state["dataDir"]) / "manuals" / state["manualId"] / "pages" / f"{citation['page']:04d}.json"
            page_record = json.loads(page_path.read_text())
            integrity = integrity and citation["manualId"] == state["manualId"] and citation["quote"] in page_record["text"] and citation["printedPage"] == page_record["printedPage"]
        result["citationIntegrity"] = integrity and bool(response.get("citations"))
        reviewed = REVIEWED_ALTERNATIVES.get(question["id"]) if state["sourceSha256"] == REVIEWED_SOURCE_SHA else None
        result["reviewedAlternativeMatch"] = bool(reviewed and any(c["page"] == reviewed["page"] and c["printedPage"] == reviewed["printedPage"] and reviewed["quote"] in c["quote"] for c in response.get("citations", [])))
        if result["reviewedAlternativeMatch"]:
            result["reviewedAlternativeEvidence"] = reviewed
        result["evidencePass"] = result["citationIntegrity"] and (result["strictPass"] or result["reviewedAlternativeMatch"])
        rows.append(result)
        print(json.dumps({"question": question["id"], "pages": result["returnedPages"], "pageHit": result["expectedPageHit"], "strictPass": result["strictPass"]}), flush=True)
        # Endpoint intentionally permits 20/minute. Pace the real requests instead of bypassing it.
        time.sleep(4)
    natural_rows = []
    for index, question in enumerate(["前后轮胎气压是多少？ ", "冷胎胎压是多少？", "轮胎应该打多少气？"], start=1):
        _, response, _ = api(state, "POST", "/v1/manuals/ask", {"vehicleId": state["vehicleId"], "question": question})
        first = next(iter(response.get("citations", [])), {})
        position = normalize(first.get("quote", "")).find("250kpa")
        integrity = False
        if first.get("page"):
            page_path = Path(state["dataDir"]) / "manuals" / state["manualId"] / "pages" / f"{first['page']:04d}.json"
            original = json.loads(page_path.read_text())
            integrity = first["manualId"] == state["manualId"] and first["quote"] in original["text"] and first["printedPage"] == original["printedPage"]
        passed = first.get("page") in [36, 359] and 0 <= position < 150 and integrity and "轮胎" in first.get("quote", "")
        natural_rows.append({"id": f"NATURAL-{index:03d}", "question": question, "passed": passed, "firstPage": first.get("page"), "normalizedValuePosition": position, "citationIntegrity": integrity, "response": response})
        print(json.dumps({"naturalQuestion": index, "firstPage": first.get("page"), "valuePosition": position, "passed": passed}), flush=True)
        time.sleep(4)
    boundary_rows = []
    boundary_questions = [q for q in fixture_data["questions"] if q["expectedBehavior"] == "insufficient_live_or_vehicle_evidence"]
    boundary_questions.append({"id": "NO-EVIDENCE", "question": "ZXQVVNOEVIDENCE998877", "expectedBehavior": "no_evidence"})
    for question in boundary_questions:
        _, response, _ = api(state, "POST", "/v1/manuals/ask", {"vehicleId": state["vehicleId"], "question": question["question"]})
        passed = response.get("source") == "no_evidence" and response.get("citations") == []
        if question["expectedBehavior"] == "insufficient_live_or_vehicle_evidence":
            passed = passed and "不能" in response.get("answer", "")
        boundary_rows.append({"id": question["id"], "question": question["question"], "passed": passed, "response": response})
        print(json.dumps({"boundary": question["id"], "passed": passed}), flush=True)
        time.sleep(4)
    comparison = {"questions": len(rows), "expectedPageHits": sum(r["expectedPageHit"] for r in rows),
                  "allExpectedTermsFound": sum(r["allExpectedTermsFound"] for r in rows),
                  "allParametersFound": sum(r["allParametersFound"] for r in rows),
                  "strictPasses": sum(r["strictPass"] for r in rows),
                  "allExtractive": all(r["source"] == "extractive" for r in rows),
                  "citationIntegrityPasses": sum(r["citationIntegrity"] for r in rows),
                  "reviewedAlternativeOnlyPasses": sum(r["evidencePass"] and not r["strictPass"] for r in rows),
                  "evidencePasses": sum(r["evidencePass"] for r in rows),
                  "boundaryPasses": sum(r["passed"] for r in boundary_rows), "boundaryQuestions": len(boundary_rows),
                  "naturalQuestionPasses": sum(r["passed"] for r in natural_rows), "naturalQuestions": len(natural_rows),
                  "queryElapsedSeconds": round(time.monotonic() - started, 2)}
    report = {"testLabel": "TEST owner and vehicle; real user-supplied GSX250R manual; no real ride data", "runId": state["runId"],
              "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "baseURL": state["baseURL"],
              "serverSourceFingerprint": state.get("serverSourceFingerprint"),
              "sourceFile": state["sourceFile"], "sourceSha256": state["sourceSha256"], "sourceBytes": state["sourceBytes"],
              "uploadedChunks": state["uploadedChunks"], "chunkSize": CHUNK_SIZE,
              "httpUploadElapsedSeconds": state["uploadElapsedSeconds"], "workerElapsedSeconds": state["workerElapsedSeconds"],
              "manualState": state["manualState"], "workerStats": state["workerStats"], "aiConfigured": False,
              "storageVerification": state.get("storageVerification"),
              "summary": comparison, "results": rows, "boundaryResults": boundary_rows, "naturalResults": natural_rows,
              "limits": ["Exact expected-page/term recall is automated; alternate correct pages are reported separately.", "No AI generation was called; this is source retrieval/extractive output acceptance.", "Local API is independent of NAS/public HTTPS/iOS physical-device acceptance."]}
    private_json(report_path, report)
    return report


def write_report_doc(report: dict, report_path: Path, state_path: Path) -> None:
    state_path = state_path.resolve()
    summary = report["summary"]
    lines = ["# GSX250R 本机真实 HTTP 手册验收", "", f"生成时间：{report['createdAt']}。测试 owner/车辆均明确标为 TEST；没有真实骑行数据。原手册是用户提供的真实文件。", "",
             "## 实际链路", "", "新建独占回环 PostgreSQL → 启动当前 server 源码 → 项目 bootstrap 创建配对码 → HTTP 配对 → HTTP 建车 → HTTP 分块上传原 PDF → worker 真正处理并写 PostgreSQL → 41 道问题调用 POST /v1/manuals/ask。AI 配置明确为空，没有调用收费模型。", "",
             f"- 原件：{report['sourceFile']}；{report['sourceBytes']} 字节；SHA-256 `{report['sourceSha256']}`。",
             f"- 上传：{report['uploadedChunks']} 块，每块上限 {report['chunkSize']} 字节；完成请求校验总 SHA；认证 Range 请求核对原始字节。HTTP 上传耗时 {report['httpUploadElapsedSeconds']} 秒。",
             f"- 入库：状态 `{report['manualState']['status']}`，进度 {report['manualState']['progress']}%，物理页 {report['manualState']['pageCount']}；worker 测试墙钟 {report['workerElapsedSeconds']} 秒。",
             f"- API：`{report['baseURL']}`；仅本机回环。源码组合 SHA `{report.get('serverSourceFingerprint','initial_run_not_recorded')}`。", "",
             "## 检索修复", "", "在同一 owner、同一车辆且 ready 的手册范围内，先获取最多 128 个候选页，再按问题所需的物理量单位、邻近部件词与表格字段排序。容量区分液体体积和电池电量；部件旁出现的参数优先于整页散落的词。未硬编码车型、页号或答案值。原文窗口最多 1200 字符，围绕相关参数截取，保持原页连续子串。", "", "实时挡位、胎压和车型适用保证问题明确返回证据不足，不把静态规格说成当前实车测量。", "",
             "## 41 题结果", "", "指标严格分开：预期页命中只比较固定 fixture 页号，其他页可能也含正确内容；参数召回不等同字段与数值关系已验证。严格通过要求至少命中一个预期页且所有 fixture 关键词均出现在返回引用中。", "",
             "| 指标 | 结果 |", "|---|---:|",
             f"| 预期物理页命中 | {summary['expectedPageHits']} / {summary['questions']} |",
             f"| 全部预期关键词出现在引用中 | {summary['allExpectedTermsFound']} / {summary['questions']} |",
             f"| 参考答案参数出现在引用中 | {summary['allParametersFound']} / {summary['questions']} |",
             f"| 严格通过 | {summary['strictPasses']} / {summary['questions']} |",
             f"| 引用逐字回查原页完整性 | {summary.get('citationIntegrityPasses','本轮未自动计分')} / {summary['questions']} |",
             f"| 原始严格规则之外，命中独立复核的替代原文 | {summary.get('reviewedAlternativeOnlyPasses', 0)} |",
             f"| 严格规则或复核替代证据通过，且引用完整 | {summary.get('evidencePasses', 0)} / {summary['questions']} |",
             f"| 全部使用 extractive，无 AI 生成 | {'是' if summary['allExtractive'] else '否'} |", "",
             "替代证据来自首轮实际返回后独立逐字核对的三处原文：怠速为 148 / 1D-9，大修油量为 223 / 1E-5，燃油压力为 255 / 1G-4。脚本只接受明确关联字段与数值的完整原句，并校验手册 SHA；原 fixture 与严格计分未改。", "",
             "| ID | 问题 | 预期页 | 返回页 | 严格结果 | 证据结果 |", "|---|---|---|---|---|---|"]
    for row in report["results"]:
        evidence_status = "严格通过" if row["strictPass"] else "替代原文通过" if row.get("evidencePass") else "失败"
        lines.append(f"| {row['id']} | {row['question'].replace('|','/')} | {','.join(map(str,row['expectedPages']))} | {','.join(map(str,row['returnedPages']))} | {'通过' if row['strictPass'] else '未通过'} | {evidence_status} |")
    if report.get("boundaryResults"):
        lines.extend(["", "## 边界问题", "", f"实际 HTTP 边界检查通过 {summary['boundaryPasses']}/{summary['boundaryQuestions']}。静态手册不能确定实时挡位、实时胎压或保证车型配置适用；无匹配词时不得返回无关页。以下均要求 `source=no_evidence`、引用为空；前三题还要求明确说不能据此判断。", "", "| ID | 问题 | 结果 |", "|---|---|---|"])
        for row in report["boundaryResults"]:
            lines.append(f"| {row['id']} | {row['question']} | {'通过' if row['passed'] else '失败'} |")
    if report.get("naturalResults"):
        lines.extend(["", "## 实际 UI 自然问句回归", "", f"新增 {summary['naturalQuestionPasses']}/{summary['naturalQuestions']} 通过。起因是 iOS 输入‘前后轮胎气压是多少？’时首条返回 ABS 故障段落；不能只凭 41 个固定题覆盖所有自然问法。下列实际 HTTP 请求要求第一条引用来自轮胎压力原页，原文中的 250 kPa 在规范化后的前 150 个字符内，且逐字属于该物理页。", "", "| 问法 | 第一物理页 | 数值位置 | 结果 |", "|---|---:|---:|---|"])
        for row in report["naturalResults"]:
            lines.append(f"| {row['question'].strip()} | {row['firstPage']} | {row['normalizedValuePosition']} | {'通过' if row['passed'] else '失败'} |")
    if report.get("storageVerification"):
        check = report["storageVerification"]
        lines.extend(["", "## 数据库与抽取一致性", "", f"实际查询 PostgreSQL `manual_pages` 得 {check['databaseRows']} 行；物理页连续完整：{check['contiguous']}。逐页比较文本、印刷页、章节、中文 tokens、质量与 worker 原页 JSON，差异 {len(check['databaseSidecarDifferences'])} 项。"])
        if "offlineReferencePages" in check:
            lines.append(f"另与独立离线抽取的 {check['offlineReferencePages']} 页逐页比较相同字段，差异 {len(check['offlineDifferences'])} 项；参考 JSONL SHA-256 `{check['offlineReferenceSha256']}`。")
    initial_path = report_path.parent / "api-acceptance-01.json"
    if initial_path.exists() and report_path != initial_path:
        initial = json.loads(initial_path.read_text())
        initial_summary = initial["summary"]
        misses = [r["id"] for r in initial["results"] if not r["allParametersFound"]]
        lines.extend(["", "## 首轮与复测边界", "", f"首轮真实 HTTP 结果保留在 `{initial_path}`：固定 fixture 严格通过 {initial_summary['strictPasses']}/41，数值召回 {initial_summary['allParametersFound']}/41。缺少参数的题号为 {', '.join(misses)}；另三题经原句复核可由替代页回答。上表为当前报告的实际请求结果，没有改写首轮返回。后续复测复用本轮已实际上传、处理并入库的原件，只重启此测试自己的 API 载入当前源码。"])
    lines.extend(["", "## 证据与复跑", "", f"本轮完整返回、缺失词与参数：`{report_path}`。连接状态与 bearer token：`{state_path}`；凭证文件权限 600、目录 700，不在文档或终端显示其值。短期 iOS 模拟器可用同目录的 `ui-pairing.json`，配对码 15 分钟有效。", "", "```bash", "python scripts/manual-e2e.py --worker-python /path/to/python", f"python scripts/manual-e2e.py --recheck-state '{state_path}'", f"python scripts/manual-e2e.py --refresh-pairing-state '{state_path}'", f"python scripts/manual-e2e.py --stop-state '{state_path}'", "```", "", "API/PG 默认保留供短期模拟器联调；stop-state 只停止这次测试自己的进程，保留私有证据文件。脚本不碰已有数据库或服务。", "", "本地上传、入库、抽取式检索均不代表 NAS 公网链路、真机后台行为、收费模型回答、实车配置适用性或维修效果已经通过。手册中原生/OCR/需复核页的具体限制见 `manual-acceptance.md`。", ""])
    (ROOT / "docs/manual-api-acceptance.md").write_text("\n".join(lines), encoding="utf-8")


def build_state(args) -> tuple[dict, Path]:
    run_id = time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:6]
    private_dir = ROOT / ".private" / ("manual-e2e-" + run_id)
    private_dir.mkdir(mode=0o700, parents=True)
    task_dir = Path(tempfile.mkdtemp(prefix="motuo-manual-e2e-"))
    os.chmod(task_dir, 0o700)
    data_dir = task_dir / "data"
    data_dir.mkdir(mode=0o700)
    pg_port, api_port = free_port(), free_port()
    while api_port == pg_port:
        api_port = free_port()
    state = {"runId": run_id, "privateDir": str(private_dir), "taskDir": str(task_dir), "dataDir": str(data_dir),
             "pgBin": args.pg_bin, "pgPort": pg_port, "apiPort": api_port, "apiTitle": "motuo-manual-e2e-" + run_id,
             "databaseURL": f"postgresql://motuo@127.0.0.1:{pg_port}/motuo_manual_e2e", "baseURL": f"http://127.0.0.1:{api_port}",
             "node": args.node, "python": args.worker_python, "sourceFile": args.pdf.name,
             "sourceBytes": args.pdf.stat().st_size, "sourceSha256": source_sha(args.pdf),
             "status": "starting", "isTestOwner": True}
    state_path = private_dir / "state.json"
    private_json(state_path, state)
    with (private_dir / "postgres-init.log").open("wb") as log:
        subprocess.run([str(Path(args.pg_bin) / "initdb"), "-D", str(task_dir / "db"), "-A", "trust", "-U", "motuo", "--no-instructions"], stdout=log, stderr=log, check=True)
        subprocess.run([str(Path(args.pg_bin) / "pg_ctl"), "-D", str(task_dir / "db"), "-o", f"-h 127.0.0.1 -p {pg_port} -k {task_dir}", "-l", str(private_dir / "postgres.log"), "-w", "start"], stdout=log, stderr=log, check=True)
        subprocess.run([str(Path(args.pg_bin) / "createdb"), "-h", "127.0.0.1", "-p", str(pg_port), "-U", "motuo", "motuo_manual_e2e"], stdout=log, stderr=log, check=True)
    return state, state_path


def fresh_run(args) -> tuple[dict, Path]:
    state, state_path = build_state(args)
    start_api(state)
    code_info = bootstrap(state)
    _, pair_result, _ = api(state, "POST", "/v1/pair", {"code": code_info["code"], "deviceName": "TEST manual HTTP E2E (not a real rider)"}, authenticated=False)
    state.update(pair_result)
    state["vehicleId"] = str(uuid.uuid4())
    private_json(state_path, state)
    vehicle = {"id": state["vehicleId"], "name": "TEST GSX250R 手册 HTTP 验收", "make": "Suzuki", "model": "GSX250R", "year": None, "abs": None, "displacementCC": 248, "plate": "", "tyres": "", "modifications": "TEST only; no real vehicle condition asserted", "odometerKM": 0}
    api(state, "PUT", "/v1/vehicles/" + vehicle["id"], vehicle)
    _, caps, _ = api(state, "GET", "/v1/capabilities")
    assert caps["ai"]["configured"] is False
    _, manual, _ = api(state, "POST", "/v1/manuals", {"vehicleId": vehicle["id"], "fileName": args.pdf.name, "totalBytes": state["sourceBytes"], "sha256": state["sourceSha256"]})
    assert manual["chunkSize"] == CHUNK_SIZE
    state["manualId"] = manual["id"]
    private_json(state_path, state)
    upload_started = time.monotonic()
    with args.pdf.open("rb") as source:
        count = 0
        for sequence, chunk in enumerate(iter(lambda: source.read(CHUNK_SIZE), b"")):
            api(state, "PUT", f"/v1/manuals/{manual['id']}/chunks/{sequence}", raw=chunk, extra_headers={"X-Content-SHA256": hashlib.sha256(chunk).hexdigest()})
            count += 1
            if count % 8 == 0:
                print(json.dumps({"uploadChunks": count, "totalChunks": math.ceil(state["sourceBytes"] / CHUNK_SIZE)}), flush=True)
    api(state, "POST", f"/v1/manuals/{manual['id']}/complete", {"expectedChunks": count})
    state["uploadedChunks"] = count
    state["uploadElapsedSeconds"] = round(time.monotonic() - upload_started, 2)
    _, after_upload, _ = api(state, "GET", f"/v1/manuals/{manual['id']}")
    assert after_upload["status"] == "queued"
    print(json.dumps({"uploadComplete": True, "chunks": count, "bytes": state["sourceBytes"], "status": "queued"}), flush=True)
    # Verify the actual authenticated file endpoint serves original bytes (not only DB metadata).
    _, first_kb, _ = api(state, "GET", f"/v1/manuals/{manual['id']}/file", extra_headers={"Range": "bytes=0-1023"})
    with args.pdf.open("rb") as src:
        assert first_kb == src.read(1024)
    original = Path(state["dataDir"]) / "manuals" / manual["id"] / "original.pdf"
    assert source_sha(original) == state["sourceSha256"]
    worker_started = time.monotonic()
    with (Path(state["privateDir"]) / "worker.log").open("ab") as log:
        worker = subprocess.Popen([state["python"], "-m", "motuo_worker", "--once"], cwd=ROOT, env=process_env(state), stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        while worker.poll() is None:
            time.sleep(5)
            _, manual_state, _ = api(state, "GET", f"/v1/manuals/{manual['id']}")
            print(json.dumps({"workerStatus": manual_state["status"], "progress": manual_state["progress"], "pageCount": manual_state["pageCount"]}), flush=True)
            if time.monotonic() - worker_started > 7500:
                worker.terminate()
                raise RuntimeError("Worker exceeded test budget")
        if worker.returncode != 0:
            raise RuntimeError("Worker process failed; inspect restricted worker.log")
    _, final_manual, _ = api(state, "GET", f"/v1/manuals/{manual['id']}")
    if final_manual["status"] != "ready":
        raise RuntimeError("Manual import did not reach ready: " + json.dumps(final_manual))
    state["manualState"] = final_manual
    state["workerElapsedSeconds"] = round(time.monotonic() - worker_started, 2)
    state["workerStats"] = json.loads((original.parent / "extraction-stats.json").read_text())
    state["status"] = "ready_for_queries"
    private_json(state_path, state)
    return state, state_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--fixture", type=Path, default=ROOT / "fixtures/manual-questions.json")
    parser.add_argument("--compare-jsonl", type=Path, help="Optional independent offline output to compare with actual DB and worker pages")
    parser.add_argument("--pg-bin", default="/opt/homebrew/bin")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--worker-python", default=os.environ.get("WORKER_PYTHON", sys.executable))
    parser.add_argument("--recheck-state", type=Path)
    parser.add_argument("--stop-state", type=Path)
    parser.add_argument("--refresh-pairing-state", type=Path)
    args = parser.parse_args()
    if args.stop_state:
        state = json.loads(args.stop_state.read_text())
        stop_api(state)
        subprocess.run([str(Path(state["pgBin"]) / "pg_ctl"), "-D", str(Path(state["taskDir"]) / "db"), "-m", "fast", "stop"], check=True, capture_output=True)
        state["status"] = "stopped"
        private_json(args.stop_state, state)
        print("Stopped only this test's API and PostgreSQL; private evidence/data retained.")
        return 0
    if args.refresh_pairing_state:
        state = json.loads(args.refresh_pairing_state.read_text())
        private_json(Path(state["privateDir"]) / "ui-pairing.json", bootstrap(state, state["ownerId"]))
        print("Refreshed 15-minute code in restricted ui-pairing.json; value not printed.")
        return 0
    if args.recheck_state:
        state_path = args.recheck_state
        state = json.loads(state_path.read_text())
        stop_api(state)
        start_api(state)
        private_json(state_path, state)
    else:
        state, state_path = fresh_run(args)
    state["storageVerification"] = validate_storage(state, args.compare_jsonl)
    private_json(state_path, state)
    sequence = len(list(Path(state["privateDir"]).glob("api-acceptance-*.json"))) + 1
    report_path = Path(state["privateDir"]) / f"api-acceptance-{sequence:02d}.json"
    report = query_fixtures(state, args.fixture, report_path)
    private_json(Path(state["privateDir"]) / "ui-pairing.json", bootstrap(state, state["ownerId"]))
    state["status"] = "running_for_short_term_ios_integration"
    state["latestReport"] = str(report_path)
    private_json(state_path, state)
    write_report_doc(report, report_path, state_path)
    print(json.dumps({"summary": report["summary"], "localAPI": state["baseURL"], "privateState": str(state_path), "privateReport": str(report_path), "pairingFile": str(Path(state["privateDir"]) / "ui-pairing.json"), "credentialsPrinted": False}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
