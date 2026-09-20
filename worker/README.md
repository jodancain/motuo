# Motuo manual worker

Python 3.12、PostgreSQL 16+、Poppler、Tesseract（`chi_sim+eng`）。原 PDF 不会上传至第三方、改写或参与模型训练。只有 NAS 自己的原文件、结构化页面和检索文本持久化。

## 本机无数据库导入

```bash
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
PYTHONPATH=worker .venv/bin/python -m motuo_worker \
  --input '/path/to/manual.pdf' --output '/tmp/manual-pages.jsonl'
```

输出为每页一条 JSONL，旁边生成 `manual-pages.stats.json`。输出文件必须不存在。每页包含物理页码、印刷页码、章节、原文、分词、段落/表格/插图坐标、单元格与合并单元格信息、质量和来源。坐标是从左上角起算的 PDF points，原图关系始终回到同一原文件物理页；不导出或重画维修插图。

`--no-ocr` 只供排查；低质量页会显式标为 `needs_review`。`--max-seconds`、`--page-timeout`、`--ocr-timeout`、`--max-ocr-pages` 限制处理预算。正常 native 页不会无条件重复 OCR；只有低质量字层/只有图片编号的页面触发本机 OCR。

## NAS 队列

使用 `worker/` 作为 Docker build context。环境变量：

| 名称 | 默认/用途 |
|---|---|
| `DATABASE_URL` | 必须设置，从部署环境读取；不能放进仓库 |
| `DATA_DIR` | 容器 `/data`；本地 `./data` |
| `MANUAL_POLL_SECONDS` | 2 秒 |
| `MANUAL_STALE_SECONDS` | 300 秒，无主的 processing 任务可恢复 |
| `MANUAL_MAX_SECONDS` | 7200 秒/次处理 |
| `MANUAL_PAGE_TIMEOUT` | 120 秒/页 |
| `MANUAL_OCR_TIMEOUT` | 60 秒/次渲染或 OCR 命令 |
| `MANUAL_MAX_OCR_PAGES` | 1000 页 |
| `OCR_LANGUAGES` | `chi_sim+eng` |

运行 `python -m motuo_worker`，或 `--once` 只处理最多一个任务。Docker 默认 uid 10001，可由 compose 覆盖为与 API 相同的 uid 1000；两容器必须共同读写 `/data`。本地临时 OCR 文件和 jieba 缓存只写 `/tmp`。

共享表完全遵循 `docs/CONTRACT.md`，由 server 建表。worker 不迁移 schema。队列先用 `FOR UPDATE SKIP LOCKED` 认领，再持有 PostgreSQL session advisory lock 避免多个工作器抢占正在运行的任务。进程死亡后锁自动释放，超时的 `processing` 从 DB+sidecar 都已提交的连续页恢复；丢失/损坏的 sidecar 从对应页重新提取。SIGTERM/SIGINT 在页面边界将任务重排为 queued；强杀保留 processing 供恢复。

每页先在事务内锁定存在且 processing 的 manual 行，再写 `manuals/{id}/pages/0001.json` 和 `manual_pages`，最后更新进度。删除会等待当前页提交；server 必须先删 DB 并提交再清目录。worker 永远不 INSERT/UPSERT manuals，因此已删资源不会复活。只有完整页数与来源 SHA 校验通过且存在可读文本时才发布 ready。

`native`、`ocr`、`needs_review`、`blank` 分别表示原生字层、OCR、需原页复核、真正空白。**ready 表示处理完成，不表示所有图表或数值已经人工确认。** OCR/低质量页应由 API 返回复核提示；无 live 数据不能根据静态手册断言实时档位、胎压、故障或本车配置。

原生解析器拒绝单页时，仅该页尝试本地 Poppler/Tesseract，保留物理页及 `NATIVE_PARSER_FAILED:<错误类型>`；质量固定 `needs_review`，不把 OCR 数值或表格称为原生证据。无 OCR 文本的页面标为 `method=unavailable`，空文本不会进入问答命中。页超时与文档超时不会降级成空页成功：即使 pdfplumber 将信号异常包装成 `PdfminerException`，仍保留 `PAGE_TIMEOUT:page=N` / `DOCUMENT_TIMEOUT:page=N`，任务失败并保留已提交页面以便明确重试。

## 受控重试失败手册

先诊断失败原因并备份 Motuo 数据；安装包含修复的新 worker 镜像后，在该 worker 的环境中运行以下命令。`DATABASE_URL` 和 `DATA_DIR` 由私有部署环境提供，不写在命令或仓库中。四项输入必须来自要恢复的原任务和已核对的原件，不能根据文件名选任务。

```bash
python -m motuo_worker.retry \
  --manual-id "$MANUAL_ID" --owner-id "$OWNER_ID" \
  --expected-sha256 "$EXPECTED_SHA256" --expected-bytes "$EXPECTED_BYTES"
```

默认 **dry-run**，仅返回状态和已提交连续页数，不修改任务、原 PDF 或页面。确认 `action=would_queue`、`validation=source_and_committed_prefix` 与预期页数后，用同一命令加 `--apply` 才将该任务从 `failed` 改为 `queued`。worker 随后从前缀下一页继续；重试工具不直接处理 PDF，也不意味着已经恢复完成。需要继续回读 `ready`、完整页数、引用原页及线上问答结果。

- 严格核对 owner/manual UUID、数据库与输入 SHA/字节数、原 PDF 实际 SHA/字节数，再检查全部已提交页面是 `1…N` 连续前缀，且每页 DB 字段、sidecar 和物理页来源一致。缺页、损坏、来源不符或符号链接时拒绝重排，不自动删页或改写证据；未提交的额外 sidecar 保留，由 worker 正常重提取对应页。
- 与 worker 使用相同 `hashtextextended(manualId, 0)` session advisory lock，按“行锁 → 非阻塞 advisory lock”的相同顺序操作，并以 owner、来源和 `failed` 状态做条件更新。正在提交页面或删除时返回 `MANUAL_BUSY`；删除已提交则返回 `MANUAL_NOT_FOUND_FOR_OWNER`，不会重建任务或目录。
- 重复调用遇到 `queued`、`processing`、`ready` 只回读 `changed=false`，保持状态、进度、时间戳和错误不变；此时 `validation=metadata_only` 明确表示没有重新校验原件/页面，不把它当作完整性验收。上传中的任务拒绝重试。
- 输出只含稳定错误码、任务/账户 UUID、状态和计数，不输出数据库凭据或手册正文。没有自动批量重试、定时器或后台重排。

## 验收

```bash
pip install -r worker/requirements-dev.txt
PYTHONPATH=worker python -m pytest worker/tests -q
WORKER_PYTHON=python3 bash worker/test-postgres.sh
python worker/verify_manual_questions.py /tmp/manual-pages.jsonl fixtures/manual-questions.json
```

PostgreSQL 测试脚本创建临时独立实例并自动清理，不碰现有实例。也可设置 `TEST_DATABASE_URL` 指向专用测试库；测试仍只使用随机隔离 schema。未配置 PG 时普通 pytest 会明确 skip 数据库测试。无 Tesseract/Poppler 时真实 OCR 测试也会 skip。受控重试覆盖默认 dry-run、重复调用、原 PDF/页面保持不变并继续处理、跨 owner/来源拒绝、同长度源文件损坏、DB/sidecar 不一致、在用 advisory lock 和删除事务互斥；这些本机测试不代表 NAS 已执行重试。

已验证用户提供的 139983190 字节、616 页 GSX250R 手册。详见 `docs/manual-acceptance.md`；41 条具体问答仅是抽取/引用验收，不代表线上 AI 问答准确率。
