import unittest

import support  # noqa: F401 — sets up the project before vo_mix is imported
from support import assert_close

import vo_mix

V = support.vectors("vo_mix")


class Place(unittest.TestCase):
    def test_vectors(self):
        for case in V["place"]:
            with self.subTest(case["name"]):
                placed, problems = vo_mix.place(case["pieces"], case["takes"], case["total"])
                self.assertEqual(len(placed), len(case["expected"]))
                for g, e in zip(placed, case["expected"]):
                    assert_close(self, [g["anchor"], g["start"], g["end"]], [e["anchor"], e["start"], e["end"]])
                self.assertEqual(problems, case["problems"])

    def test_errors(self):
        for case in V["place_errors"]:
            with self.subTest(case["name"]), self.assertRaises(SystemExit):
                vo_mix.place(case["pieces"], case["takes"], case["total"])


if __name__ == "__main__":
    unittest.main()
