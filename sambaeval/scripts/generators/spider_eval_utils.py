"""Result-set comparison for Spider execution accuracy.

Vendored / adapted from the official Spider test-suite evaluator
(https://github.com/taoyds/test-suite-sql-eval, exec_eval.py) so our execution
accuracy matches the benchmark's semantics:

* When the gold query has no top-level ORDER BY, two result sets are equal iff
  they are equal as *multisets* of rows — row order is irrelevant.
* When the gold query has a top-level ORDER BY, row order is significant.
* In both cases we are tolerant to the *column* order of the SELECT clause:
  a prediction that returns the right columns in a different order is counted
  correct, matching the official evaluator (which searches column permutations
  after a cheap pre-rejection check).

The column-permutation search is factorial in the number of columns, so it is
guarded: result sets wider than PERMUTATION_COL_CAP fall back to a direct
comparison in the columns' natural order (the common case — wide SELECTs almost
always preserve column order).
"""

from __future__ import annotations

import re
from collections import Counter
from itertools import permutations

# Above this many columns we skip the permutation search (see module docstring).
PERMUTATION_COL_CAP = 5


def gold_order_matters(query: str) -> bool:
    """True iff the (gold) query has an ORDER BY that fixes row order.

    Best-effort textual check: looks for the `order by` keyword outside of
    quoted strings. Spider's gold queries are simple enough that this is
    reliable; a stray "order by" inside a string literal would be a false
    positive, but none occur in the dev set.
    """
    # Strip single/double-quoted string literals so a literal "order by"
    # inside a value doesn't trigger.
    without_strings = re.sub(r"'[^']*'|\"[^\"]*\"", "", query)
    return re.search(r"\border\s+by\b", without_strings, re.IGNORECASE) is not None


def _normalize_row(row) -> tuple:
    # sqlite returns tuples already; coerce defensively and make hashable.
    return tuple(row)


def _unordered_row(row: tuple) -> tuple:
    """A row's values sorted into a canonical order (type-stable).

    Used by the quick pre-rejection: if two result sets disagree even after
    sorting each row's cells, no column permutation can reconcile them.
    """
    return tuple(sorted(row, key=lambda x: (str(type(x)), str(x))))


def _multiset_eq(a: list, b: list) -> bool:
    if len(a) != len(b):
        return False
    return Counter(a) == Counter(b)


def _quick_reject(r1: list, r2: list, order_matters: bool) -> bool:
    """Cheap necessary-condition check before the permutation search.

    Returns True if the two results *could* still be equal under some column
    permutation; False if they definitely cannot.
    """
    s1 = [_unordered_row(row) for row in r1]
    s2 = [_unordered_row(row) for row in r2]
    if order_matters:
        return s1 == s2
    return _multiset_eq(s1, s2)


def _permute(row: tuple, perm: tuple[int, ...]) -> tuple:
    return tuple(row[i] for i in perm)


def result_eq(pred_rows: list, gold_rows: list, order_matters: bool) -> bool:
    """True iff the predicted and gold result sets are equal under Spider's
    execution-accuracy semantics (see module docstring)."""
    pred = [_normalize_row(r) for r in pred_rows]
    gold = [_normalize_row(r) for r in gold_rows]

    if len(pred) != len(gold):
        return False
    if not pred:  # both empty
        return True

    num_cols = len(gold[0])
    if len(pred[0]) != num_cols:
        return False

    # Fast path / direct comparison in natural column order.
    if order_matters:
        if pred == gold:
            return True
    elif _multiset_eq(pred, gold):
        return True

    if not _quick_reject(pred, gold, order_matters):
        return False

    # Too wide to search permutations: the direct comparison above is our answer.
    if num_cols > PERMUTATION_COL_CAP:
        return False

    for perm in permutations(range(num_cols)):
        permuted = [_permute(row, perm) for row in gold]
        if order_matters:
            if pred == permuted:
                return True
        elif _multiset_eq(pred, permuted):
            return True
    return False
