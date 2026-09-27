import unittest

import support  # noqa: F401 — sets up the project before assemble is imported
from support import assert_close

import assemble

V = support.vectors("assemble")


class Windows(unittest.TestCase):
    def test_vectors(self):
        for case in V["windows"]:
            with self.subTest(case["name"]):
                got = assemble.windows(case["item"], case["meta"])
                self.assertEqual(len(got), len(case["expected"]), got)
                for g, e in zip(got, case["expected"]):
                    self.assertEqual((g[0], g[3]), (e[0], e[3]))
                    assert_close(self, g[1:3], e[1:3])

    def test_errors(self):
        for case in V["windows_errors"]:
            with self.subTest(case["name"]), self.assertRaises(SystemExit):
                assemble.windows(case["item"], case["meta"])


class SpeedTag(unittest.TestCase):
    def test_vectors(self):
        for speed, want in V["speed_tag"]:
            with self.subTest(speed=speed):
                self.assertEqual(assemble.speed_tag(speed), want)


if __name__ == "__main__":
    unittest.main()
