import unittest

import support  # noqa: F401 — sets up the project before cut is imported
from support import assert_close

import cut

V = support.vectors("cut")


class Segments(unittest.TestCase):
    def test_vectors(self):
        for case in V["segments"]:
            with self.subTest(case["name"]):
                got = cut.segments(case["log"])
                self.assertEqual([s["name"] for s in got], [s["name"] for s in case["expected"]])
                for g, e in zip(got, case["expected"]):
                    assert_close(self, [g["a"], g["b"], g["speed"]], [e["a"], e["b"], e["speed"]])


class Smooth(unittest.TestCase):
    def test_vectors(self):
        for k, want in V["smooth"]:
            with self.subTest(k=k):
                assert_close(self, cut.smooth(k), want)


class ViewTrack(unittest.TestCase):
    def test_vectors(self):
        for case in V["view_track"]:
            with self.subTest(case["name"]):
                w, h = case["src"]
                got = cut.view_track(case["log"], w, h, case["dpr"])
                self.assertEqual(len(got), len(case["expected"]))
                for (gt, gbox), (et, ebox) in zip(got, case["expected"]):
                    assert_close(self, gt, et)
                    assert_close(self, gbox, ebox)


class BoxAt(unittest.TestCase):
    def test_vectors(self):
        for case in V["box_at"]:
            for t, want in case["samples"]:
                with self.subTest(case["name"], t=t):
                    assert_close(self, cut.box_at(case["keys"], t), want)


if __name__ == "__main__":
    unittest.main()
