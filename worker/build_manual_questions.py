"""Build reviewable GSX250R evidence fixtures from a completed local extraction.

The questions and answers below were read from the supplied manual. This helper
copies the exact nearby source text; it does not generate answers with a model.
"""
import argparse
import json
from pathlib import Path


# page, question, answer, exact source terms, source anchor
CASES = [
    (19, "GSX250R 的 VIN 和发动机编号分别在哪里？", "VIN 打刻在转向柱右侧；发动机编号在左曲轴箱。", ["转向柱右侧", "左曲轴箱"], "系列编号位置"),
    (24, "保养表中 I、R、T 各表示什么？", "I 表示按需要检查、清洁、调整、更换或润滑；R 是更换；T 是紧固。", ["I =", "R = 更换", "T = 紧固"], "I ="),
    (24, "手册要求驱动链条多长里程检查、清洗和润滑？", "每 1000 公里。", ["每1000 公里检查、清洗、机油润滑"], "驱动链条(I:"),
    (24, "手册定期保养表的公里数列是什么？", "1000、5000、10000、15000 公里。", ["1000", "5000", "10000", "15000"], "公 里"),
    (30, "手册记载的轴距和座垫高度是多少？", "轴距 1430 mm，座垫高度 790 mm。", ["1430 mm", "790 mm"], "轴距"),
    (30, "GSX250R 标准怠速是多少？", "1400 ± 100 r/min。", ["1400 ± 100 r/min"], "怠速 |"),
    (30, "手册中的变速器挡数和变挡模式是什么？", "六挡齿轮变速，1-下、5-上。", ["六挡齿轮变速", "1-下，5-上"], "变速器 |"),
    (30, "一挡和六挡变速比分别是多少？", "一挡为 2.416 (29/12)，六挡为 0.807 (21/26)。", ["2.416 (29/12)", "0.807 (21/26)"], "变速比 |"),
    (30, "初级与末级传动比是多少？", "初级 3.238 (68/21)，末级 3.285 (46/14)。", ["3.238 (68/21)", "3.285 (46/14)"], "初级传动比"),
    (31, "GSX250R 燃油箱容量是多少？", "15 L。", ["燃油箱 | | 15 L"], "容量"),
    (31, "只换机油和连滤芯一起更换，各需要多少机油？", "只换机油 2100 ml，包含更换滤芯 2200 ml。", ["2100 ml", "2200 ml"], "发动机机油 | 更换机油"),
    (31, "手册标注的发动机冷却液总量是多少？", "1350 ml。", ["发动机冷却液 | | 1350 ml"], "容量"),
    (31, "前后无内胎轮胎的规格分别是什么？", "前 110/80-17M/C 57H，后 140/70-17M/C 66H，均无内胎。", ["110/80-17M/C 57H", "140/70-17M/C 66H", "无内胎"], "前轮胎尺寸"),
    (31, "主保险和普通保险的额定电流各是多少？", "主保险 30 A，普通保险 10 A。", ["主保险 | 30 A", "保险 | 10 A"], "主保险 |"),
    (32, "油门拉索的标准间隙是多少？", "2.0 – 4.0 mm。", ["油门拉索间隙 | | 2.0 – 4.0 mm"], "油门拉索间隙"),
    (33, "冷机时进气和排气气门间隙各是多少？", "进气 0.05 – 0.10 mm，排气 0.17 – 0.22 mm；适用于冷机。", ["冷", "0.05 – 0.10 mm", "0.17 – 0.22 mm"], "气门间隙 |"),
    (34, "发动机大修后的机油加注标准量是多少？", "2400 ml。", ["发动机大修 | 2400 ml"], "机油更换量"),
    (35, "发动机侧与副水箱侧冷却液容量各是多少？", "发动机侧约 1100 ml，副水箱侧约 250 ml。", ["发动机侧 | 大约 1100 ml", "副水箱侧 | 大约 250 ml"], "发动机冷却液 |"),
    (35, "冷却风扇大约在什么温度开启和关闭？", "约 105 °C 开启，约 99 °C 关闭。", ["OFF → ON | 大约 105 °C", "ON → OFF | 大约 99 °C"], "冷却风扇开闭温度"),
    (35, "燃油压力的标准范围是多少？", "289 – 299 kPa。", ["燃油压力 | | 289 – 299 kPa"], "燃油压力 |"),
    (36, "蓄电池型号和容量是什么？", "型号 YTX9-BS，12 V、8 Ah/10 HR。", ["YTX9-BS", "8 Ah"], "蓄电池 |"),
    (36, "蓄电池漏电电流上限是多少？", "3 mA 或更低。", ["蓄电池漏电电流 | | | 3 mA 或更低"], "蓄电池漏电电流"),
    (36, "5000 r/min 下整流充电输出电压范围是多少？", "14.0 – 15.5 V。", ["5000", "14.0 – 15.5 V"], "整流电压 |"),
    (36, "单只前减震器的加油量是多少？", "366 ml。", ["前减震器加油量 | 单只 | 366 ml"], "前减震器加油量"),
    (36, "冷态轮胎气压在单人和双人骑行时各是多少？", "手册表中单人、双人骑行的前后轮均为 250 kPa。", ["单人", "双人", "250 kPa"], "冷态轮胎气压"),
    (36, "前后轮胎花纹深度的推荐极限各是多少？", "前 1.6 mm，后 2.0 mm。", ["前 | — | 1.6 mm", "后 | — | 2.0 mm"], "轮胎花纹深度"),
    (36, "驱动链条的型号、节数和松弛度标准是什么？", "RK520KRO，116 节；支起边撑时松弛度 20 – 30 mm。", ["RK520KRO", "116 节", "支起边撑", "20 – 30 mm"], "驱动链条 | 型号"),
    (37, "前制动盘标准厚度与厚度极限分别是多少？", "标准 5.0 mm，极限 4.5 mm。", ["前制动盘厚度 | | 5.0 mm | 4.5 mm"], "前制动盘厚度"),
    (37, "后制动盘标准厚度与厚度极限分别是多少？", "标准 4.5 mm，极限 4.0 mm。", ["后制动盘厚度 | | 4.5 mm | 4.0 mm"], "后制动盘厚度"),
    (37, "挡位开关的输入电压范围是多少？", "4.5 – 5.5 V。", ["挡位开关输入电压 | | 4.5 – 5.5 V"], "挡位开关输入电压"),
    (37, "离合器拉索间隙的标准值是多少？", "10 – 15 mm。", ["离合器拉索间隙 | | 10 – 15 mm"], "离合器拉索间隙"),
    (37, "后制动踏板的标准高度是多少？", "45 – 55 mm。", ["后制动踏板高度 | | 45 – 55 mm"], "后制动踏板高度"),
    (41, "手册推荐的发动机机油粘度等级是什么？", "SAE 10W-40。", ["粘度等级 SAE 10W-40"], "发动机机油\nAPI"),
    (41, "手册允许的制动液规格是什么？", "DOT 3 或 DOT 4，并注明使用以乙二醇为基的制动液。", ["DOT 3 或 DOT 4", "以乙二醇为基"], "制动液\n规格"),
    (41, "手册是否推荐 ENERGY CONSERVING 标识的机油？", "不推荐，手册指出其会影响发动机寿命和离合器性能。", ["不推荐使用有“ENERGY CONSERVING”标识的机油"], "不推荐使用"),
    (223, "机油放油螺塞的规定扭矩是多少？", "23 N·m。", ["放油螺塞 (a): 23 N·m"], "放油螺塞 (a):"),
    (223, "机油滤芯的规定扭矩是多少？", "20 N·m。", ["机油滤芯 (a): 20 N·m"], "机油滤芯 (a):"),
    (276, "火花塞的规定拧紧扭矩是多少？", "11 N·m。", ["火花塞: 11 N·m"], "火花塞: 11 N·m"),
    (277, "火花塞型号和标准间隙是多少？", "NGK CPR7EA-9 或 DENSO U22EPR9，间隙 0.8 – 0.9 mm。", ["CPR7EA-9", "U22EPR9", "0.8 – 0.9 mm"], "火花塞\n型号"),
    (369, "调整驱动链条后的后轮轴螺母扭矩是多少？", "65 N·m；拧紧后再次检查链条松紧度。", ["后轮轴螺母：65 N·m", "再次检查驱动链条的松紧度"], "后轮轴螺母："),
    (369, "能用煤油或高压清洗机清洗驱动链条吗？", "手册禁止使用煤油等挥发性溶剂、高压清洗机及钢丝刷清洗驱动链条。", ["煤油", "不要用高压清洗机", "不要用钢丝刷"], "不要使用挥发性溶剂"),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("extraction", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    pages = {r["page"]: r for r in map(json.loads, args.extraction.read_text().splitlines())}
    questions = []
    for i, (number, question, answer, terms, anchor) in enumerate(CASES, 1):
        page = pages[number]
        for term in terms:
            assert term in page["text"], (i, number, term)
        start = page["text"].index(anchor)
        term_ends = [page["text"].find(term, start) + len(term) for term in terms]
        end = max(start + 120, *term_ends)
        # Keep a compact contiguous source excerpt, preserving the complete row.
        end = page["text"].find("\n", min(len(page["text"]), end))
        if end == -1:
            end = len(page["text"])
        quote = page["text"][start:end]
        questions.append({"id": f"GSX-{i:03d}", "question": question, "expectedAnswer": answer,
                          "expectedTerms": terms, "expectedPages": [number], "expectedBehavior": "cited_answer",
                          "citations": [{"page": number, "printedPage": page["printedPage"], "section": page["section"], "quote": quote}]})
    for i, question in enumerate([
        "只根据这本维修手册，告诉我现在这辆车确切挂在第几挡。",
        "只根据这本维修手册，告诉我现在前后轮的实时胎压。",
        "我没提供车型年份和 ABS 配置，能保证每项参数适合我的实车吗？",
    ], len(questions) + 1):
        questions.append({"id": f"GSX-{i:03d}", "question": question, "expectedBehavior": "insufficient_live_or_vehicle_evidence", "expectedPages": [], "expectedTerms": [], "citations": []})
    stats = json.loads(args.extraction.with_suffix(".stats.json").read_text())
    document = {"schemaVersion": 1, "sourceFile": "SUZUKI GSX250R 维修手册中文版(1).pdf", "sourceSha256": stats["sha256"], "sourceBytes": stats["total_bytes"], "sourcePages": 616,
                "validationScope": "Local extraction and citation evidence, not live model retrieval or repair effectiveness.", "questions": questions}
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    print(f"Created {len(CASES)} evidence questions and 3 boundary questions.")


if __name__ == "__main__":
    main()
