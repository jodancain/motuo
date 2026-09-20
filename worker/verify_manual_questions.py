"""Check supplied PDF extraction against independently curated numeric questions."""
import argparse
import json
from pathlib import Path


def verify(extraction: Path, fixture: Path) -> dict:
    records = {r["page"]: r for r in map(json.loads, extraction.read_text().splitlines())}
    expected = json.loads(fixture.read_text())
    stats = json.loads(extraction.with_suffix(".stats.json").read_text())
    assert stats["sha256"] == expected["sourceSha256"], "Source mismatch"
    assert len(records) == expected["sourcePages"] == stats["processed_pages"]
    assert sorted(records) == list(range(1, len(records) + 1))
    passed = 0
    for question in expected["questions"]:
        if question["expectedBehavior"] != "cited_answer":
            continue
        for citation in question["citations"]:
            page = records[citation["page"]]
            assert page["source"]["physicalPage"] == citation["page"]
            assert page["printedPage"] == citation["printedPage"]
            assert citation["quote"] in page["text"], question["id"] + ": quote mismatch"
            for term in question["expectedTerms"]:
                assert term in page["text"], question["id"] + ": missing term " + term
                assert term in citation["quote"], question["id"] + ": answer term outside citation " + term
        passed += 1
    # A digit-collapse regression must never pass just by retaining one value.
    assert all(value in records[24]["text"] for value in ["1000", "5000", "10000", "15000"])
    assert "11 N·m" in records[276]["text"]
    assert "09900–25009" in records[13]["text"]
    assert records[25]["text"].index("怠速\n") < records[25]["text"].index("油门拉索检查和调整")
    assert records[222]["text"].index("静置三分钟") < records[222]["text"].index("发动机机油更换\n")
    assert records[15]["printedPage"] == "1-i", "TOC header must not become a body cross-reference"
    result = {"sourcePages": len(records), "citedQuestionsPassed": passed, "boundaryQuestions": len(expected["questions"]) - passed, "verifiedSourceSha256": stats["sha256"], "scope": "extraction, numeric preservation, column order, exact source quotes; not online retrieval"}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("extraction", type=Path)
    parser.add_argument("fixture", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.extraction, args.fixture), ensure_ascii=False, indent=2))
