import unittest

import support  # noqa: F401 — sets up the project before pauses is imported
from support import assert_close

import pauses

V = support.vectors("pauses")


class Merge(unittest.TestCase):
    def test_vectors(self):
        for case in V["merge"]:
            with self.subTest(case["name"]):
                assert_close(self, pauses.merge(case["spans"]), case["expected"])


if __name__ == "__main__":
    unittest.main()
