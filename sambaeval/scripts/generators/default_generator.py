"""Default OutputGenerator script for sambaeval.

Sambaeval uses this script whenever an experiment leaves its
`output_generator` field blank. It just runs the base `OutputGenerator`
class from `base.py`, which sends the system + user prompt as a single
streaming chat completion and returns the model's text.

To define custom behavior (tool use, SQL execution, an agentic loop,
etc.), make a copy of this file alongside it, subclass `OutputGenerator`
to override `generate_output` (and `stream_completion` if you need to
capture more than text from the stream), and point your experiment's
`output_generator` field at your new script.
"""

from base import OutputGenerator, run_cli


if __name__ == "__main__":
    run_cli(OutputGenerator)
