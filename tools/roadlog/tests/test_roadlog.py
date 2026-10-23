import contextlib
import gzip
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "examples"))
import roadlog  # noqa: E402
import roadlog_lib as rl  # noqa: E402
import synth  # noqa: E402

try:
    import pyarrow  # noqa: F401
    HAVE_ARROW = True
except ImportError:
    HAVE_ARROW = False
try:
    import matplotlib  # noqa: F401
    HAVE_MPL = True
except ImportError:
    HAVE_MPL = False


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = roadlog.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="roadlog-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make(self, **kw):
        kw.setdefault("seconds", 180)
        return synth.generate(self.tmp, **kw)


class VerifyTests(Base):
    def test_clean_package_verifies(self):
        pkg = self.make(audio=True)
        r = rl.verify(rl.Package(pkg))
        self.assertTrue(r["ok"], r["problems"])
        self.assertEqual(r["state"], "sealed")
        code, out, _ = run("--root", str(self.tmp), "verify", "--all")
        self.assertEqual(code, 0)
        self.assertIn("OK", out)

    def test_faults_are_reported_specifically(self):
        cases = {"bad_sha": "SHA-256 不符", "missing_chunk": "缺少 streams/gyro_raw/000002.csv.gz", "no_manifest": "manifest.json 缺失",
                 "icloud_placeholder": "尚未从 iCloud 下载"}
        for fault, text in cases.items():
            with self.subTest(fault=fault):
                root = self.tmp / fault
                pkg = synth.generate(root, seconds=180, faults=[fault])
                r = rl.verify(rl.Package(pkg))
                self.assertFalse(r["ok"])
                self.assertTrue(any(text in p for p in r["problems"]), r["problems"])
        code, _, _ = run("--root", str(self.tmp / "bad_sha"), "verify", "--all")
        self.assertEqual(code, 1)

    def test_half_line_jsonl_is_tolerated_but_flagged(self):
        pkg = self.make(faults=["half_jsonl"])
        records, partial, bad = rl.read_jsonl(pkg / "events.jsonl")
        self.assertTrue(partial)
        self.assertEqual(bad, 0)
        self.assertEqual(records[0]["type"], "ride_start")
        r = rl.verify(rl.Package(pkg))
        self.assertTrue(any("events.jsonl" in p for p in r["problems"]), "changed file no longer matches manifest sha")
        self.assertTrue(any("未写完" in w for w in r["warnings"]))

    def test_leftover_part_warns(self):
        pkg = self.make(faults=["part_left"])
        r = rl.verify(rl.Package(pkg))
        self.assertTrue(r["ok"])
        self.assertTrue(any(".csv.part" in w for w in r["warnings"]))

    def test_non_monotonic_rows_and_header_mismatch_fail(self):
        pkg = self.make()
        manifest = json.loads((pkg / "manifest.json").read_text())
        chunk = manifest["streams"]["gyro_raw"]["chunks"][0]
        path = pkg / chunk["file"]
        lines = gzip.decompress(path.read_bytes()).decode().splitlines()
        lines[0] = lines[0].replace("x", "gx")
        lines[5], lines[6] = lines[6], lines[5]
        raw = ("\n".join(lines) + "\n").encode()
        data = gzip.compress(raw)
        path.write_bytes(data)
        chunk.update(bytes=len(data), sha256=rl.hashlib.sha256(data).hexdigest(), uncompressed_bytes=len(raw))
        text = json.dumps(manifest).encode()
        (pkg / "manifest.json").write_bytes(text)
        (pkg / "manifest.sha256").write_text(rl.hashlib.sha256(text).hexdigest() + "  manifest.json\n")
        problems = rl.verify(rl.Package(pkg))["problems"]
        self.assertTrue(any("表头" in p for p in problems), problems)
        self.assertTrue(any("倒退" in p for p in problems), problems)


class ReadTests(Base):
    def test_clock_mapping_nearest_sample(self):
        c = rl.ClockMap([{"t_mono": 100, "t_unix": 1000}, {"t_mono": 110, "t_unix": 1010.5}])
        self.assertAlmostEqual(c.to_unix(103), 1003)
        self.assertAlmostEqual(c.to_unix(108), 1008.5)
        self.assertAlmostEqual(c.to_unix(90), 990)
        self.assertIsNone(rl.ClockMap([]).to_unix(1))

    def test_missing_values_read_as_none(self):
        pkg = rl.Package(self.make())
        header, rows = pkg.read_stream("location")
        self.assertEqual(header[0], "t_mono")
        self.assertIsNone(rows[0][header.index("floor")])
        self.assertIsInstance(rows[0][header.index("lat")], float)

    def test_interval_stats_and_gap_detection(self):
        times = [i * 0.01 for i in range(100)] + [5 + i * 0.01 for i in range(100)]
        s = rl.interval_stats(times)
        self.assertAlmostEqual(s["hzFromMedian"], 100, places=3)
        self.assertAlmostEqual(s["maxIntervalS"], 5 - 0.99, places=6)
        gaps = rl.detect_gaps("motion", times, [])
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["reason"], "sensor_stall")
        self.assertEqual(rl.detect_gaps("motion", times, [(1.5, 4.0)])[0]["reason"], "paused")
        self.assertEqual(rl.detect_gaps("location", [0, 1, 2, 9, 10], [])[0]["reason"], "gps_lost")

    def test_haversine_and_distance_filter(self):
        self.assertAlmostEqual(rl.haversine(0, 0, 0, 1), 111195, delta=5)
        header = ["t_mono", "lat", "lon", "h_acc_m"]
        rows = [[0, 31.0, 121.0, 5], [1, 31.0001, 121.0, 5], [2, 31.5, 121.0, 80], [3, 31.0002, 121.0, 5], [30, 31.0003, 121.0, 5]]
        self.assertAlmostEqual(rl.gps_distance(header, rows), 2 * 11.12, delta=0.1)


class CommandTests(Base):
    def test_list_reports_states_and_missing_root(self):
        self.make()
        synth.generate(self.tmp, seconds=60, start_unix=1792660000.0, seed=3, faults=["no_manifest"])
        code, out, _ = run("--root", str(self.tmp), "list")
        self.assertEqual(code, 0)
        self.assertIn("sealed SIM", out)
        self.assertIn("incomplete-sync", out)
        code, _, err = run("--root", str(self.tmp / "nope"), "list")
        self.assertEqual(code, 2)
        self.assertIn("没有找到路谱目录", err)

    def test_summary_numbers(self):
        pkg = self.make(seconds=600)
        s = rl.summary(rl.Package(pkg))
        self.assertEqual(s["streams"]["motion"]["rows"], 60000)
        self.assertAlmostEqual(s["streams"]["motion"]["hzOverall"], 100, places=2)
        self.assertEqual(s["streams"]["location"]["rows"], 590)
        self.assertTrue(any(g["stream"] == "location" and g["reason"] == "gps_lost" for g in s["gaps"]["detected"]))
        self.assertGreater(s["gps"]["distanceM"], 3000)
        self.assertLess(s["gps"]["maxSpeedKmh"], 70)
        self.assertEqual(s["events"]["signalKinds"]["suspectedShift"], 8)
        self.assertEqual(s["streams"]["batched_accel"]["status"], "unsupported")
        code, out, _ = run("--root", str(self.tmp), "summary", "--all")
        self.assertEqual(code, 0)
        self.assertIn("GPS 里程", out)
        code, out, _ = run("--root", str(self.tmp), "summary", "--all", "--json")
        self.assertEqual(json.loads(out)[0]["streams"]["motion"]["rows"], 60000)

    def test_export_csv(self):
        pkg = self.make(seconds=90)
        code, out, _ = run("--root", str(self.tmp), "export", pkg.name, "--out", str(self.tmp / "out"), "--format", "csv", "--streams", "motion,location")
        self.assertEqual(code, 0)
        lines = (self.tmp / "out" / pkg.name / "motion.csv").read_text().splitlines()
        self.assertEqual(lines[0].split(",")[:2], ["t_mono", "t_unix"])
        self.assertEqual(len(lines), 9001)
        t_mono, t_unix = map(float, lines[1].split(",")[:2])
        self.assertAlmostEqual(t_unix - t_mono, 1792656000.0 - 10000.0, places=3)
        self.assertTrue((self.tmp / "out" / pkg.name / "events.csv").exists())

    @unittest.skipUnless(HAVE_ARROW, "pyarrow 未安装")
    def test_export_parquet(self):
        import pyarrow.parquet as pq
        pkg = self.make(seconds=60)
        result = rl.export(rl.Package(pkg), self.tmp / "out", "parquet", ["motion"])
        table = pq.read_table(result["files"][0])
        self.assertEqual(table.num_rows, 6000)
        self.assertEqual(table.column_names[:2], ["t_mono", "t_unix"])


class ExampleTests(Base):
    def test_alignment_recovers_forward_axis(self):
        import align_speed_accel as ex
        pkg = rl.Package(self.make(seconds=600))
        r = ex.analyse(pkg)
        self.assertGreater(r["pairs"], 100)
        self.assertGreater(abs(r["forward"][1]), 0.9, r["forward"])   # synthetic mount: forward = device y
        self.assertGreater(r["correlation"], 0.9)

    def test_script_degrades_without_matplotlib_or_plots(self):
        import align_speed_accel as ex
        pkg = self.make(seconds=200)
        out = self.tmp / "plot.png"
        argv = sys.argv
        sys.argv = ["align", str(pkg), "--out", str(out)]
        try:
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                self.assertEqual(ex.main(), 0)
        finally:
            sys.argv = argv
        if HAVE_MPL:
            self.assertTrue(out.exists())
        else:
            self.assertTrue(out.with_suffix(".csv").exists())
            self.assertIn("matplotlib", buf.getvalue())
        self.assertIn("估计", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
