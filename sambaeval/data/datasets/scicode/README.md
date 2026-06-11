# SciCode fixture & conversion

This folder holds the [SciCode](https://github.com/scicode-bench/SciCode) problem
fixture used by the `scicode_example` experiment, plus the raw upstream inputs
needed to regenerate it. Only `scicode_problems.jsonl` is committed; everything
under "Files" marked gitignored must be supplied locally to re-run the conversion.

## Files

| File | Committed? | Purpose |
| ---- | ---------- | ------- |
| `scicode_problems.jsonl` | ✅ yes | The canonical, self-contained fixture the generator reads (all 80 problems, with `step_background` when available). |
| `problems_dev.jsonl` | ❌ gitignored | HuggingFace source, validation split (15 problems). Carries the scientist `step_background`. |
| `problems_test.jsonl` | ❌ gitignored | HuggingFace source, test split (65 problems). Carries the scientist `step_background`. |
| `problems_all.jsonl` | ❌ gitignored | Legacy single-file source (80 problems, **no** backgrounds). Optional fallback, used only when the dev/test splits are absent. |
| `13.6.txt`, `62.1.txt`, `76.3.txt` | ❌ gitignored | "Given code" snippets for the three steps SciCode supplies rather than asking the model to generate (referenced by `GIVEN_CODE_FILES` in the converter). |
| `background_comment_template.txt` | ❌ gitignored | SciCode's self-generated-background prompt template, for reference. Not used by the converter or generator. |

`test_data.h5` (the ~1 GB numeric reference data the tests compare against) is
downloaded separately and pointed at via `test_data_h5_path` in
`scripts/generators/scicode_generator.py` — see the main README.

## Where to get the source files

- **`problems_dev.jsonl` / `problems_test.jsonl`** — official HuggingFace dataset
  [SciCode1/SciCode](https://huggingface.co/datasets/SciCode1/SciCode). Direct:
  - <https://huggingface.co/datasets/SciCode1/SciCode/resolve/main/problems_dev.jsonl>
  - <https://huggingface.co/datasets/SciCode1/SciCode/resolve/main/problems_test.jsonl>

  ```bash
  cd data/datasets/scicode
  curl -L -O https://huggingface.co/datasets/SciCode1/SciCode/resolve/main/problems_dev.jsonl
  curl -L -O https://huggingface.co/datasets/SciCode1/SciCode/resolve/main/problems_test.jsonl
  ```
- **`problems_all.jsonl`, `13.6.txt`, `62.1.txt`, `76.3.txt`,
  `background_comment_template.txt`** — the [SciCode GitHub repo](https://github.com/scicode-bench/SciCode)
  under `eval/data/` (the `*.txt` files are the given-code snippets / templates
  used by its `eval/scripts/gencode.py`). `problems_all.jsonl` is optional; the
  dev+test pair above supersedes it (and adds backgrounds).

## Regenerating the fixture

Place the source files in this folder, then from the project root:

```bash
python scripts/convert_scicode.py   # writes scicode_dev + scicode_test
```

This rewrites `scicode_problems.jsonl` (the fixture, all 80 problems) and the two
SambaEval datasets `../scicode_dev.jsonl` (15 problems) and `../scicode_test.jsonl`
(65 problems), each scored with the `ratio:` heuristic. The split mirrors SciCode's
official dev/test sets: every problem in `problems_dev.jsonl` goes to the dev
dataset, every problem in `problems_test.jsonl` to the test dataset.

**Source precedence:** the HuggingFace splits `problems_dev.jsonl` + `problems_test.jsonl`
when present (these carry the scientist `step_background` inline), otherwise the
legacy `problems_all.jsonl` (no backgrounds). If no source files are present the
converter just re-splits the existing committed fixture (using the first 15
fixture problems as the dev set, since the legacy file has no split designation).

**Why the dev `example_id`s aren't 1..15:** each `example_id` is SciCode's
canonical `problem_id` (1–80), not a row index. The dev split is a *scattered*
subset of those ids — `1, 3, 4, 6, 7, 10, 19, 29, 38, 44, 47, 49, 51, 70, 78` —
chosen by the SciCode authors as the validation set, so `scicode_dev.jsonl` holds
exactly those non-contiguous ids while the rest land in `scicode_test.jsonl`. This
is purely the dev/test split membership — it is **not** related to `test_data.h5`,
which is keyed by sub-step (e.g. `"12.1"`) and only supplies the numeric reference
values, never the problem ids or their order.

The three `*.txt` given-code snippets supply the three "given" steps, and any
`from scicode... import ...` lines are stripped from test cases (that helper is
vendored in `scripts/generators/scicode_test_utils.py`).

## Background (with-background setting)

SciCode's *with-background* setting gives the model the scientist-written
knowledge (and conventions, e.g. the unit system a formula should use) for each
step.

> **With-/no-background is a runtime generator setting, NOT a conversion-script
> option.** The converter has no background flag — it *always* writes whatever
> `step_background` the source provides into the fixture (empty string when the
> source omits it). Whether that background is actually shown to the model is
> decided at run time by the **`SCICODE_WITH_BACKGROUND`** environment variable
> read by `scripts/generators/scicode_generator.py`:
>
> - `SCICODE_WITH_BACKGROUND=1` (default) — inject each step's `step_background`
>   into its prompt (with-background).
> - `SCICODE_WITH_BACKGROUND=0` — ignore it even though it's in the fixture
>   (the harder no-background setting).
>
> So you can switch settings without regenerating the fixture — just set the env
> var. Steps that have no background in the source run no-background regardless.

This matters for convention-dependent steps. Problem 12 step 1 asks for `f(r)`
in `u'' = f(r)u(r)`; the answer key uses **Rydberg** units
(`f = l(l+1)/r² − 2Z/r − E`), while the textbook reduction of the equation as
written gives **Hartree** units (`− 2E`). With no background the model has no way
to know which the grader expects (it reasonably defaults to Hartree, and the
wrong convention cascades through every dependent step). The `step_background`
states the Rydberg scaling, which is the intended way to disambiguate — though
note a model can still mis-apply it (e.g. inserting a literal eV→Rydberg
conversion when the function's `energy` argument is already dimensionless). The
paper reports both settings precisely because of this gap.
