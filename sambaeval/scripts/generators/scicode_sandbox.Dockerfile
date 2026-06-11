# Sandbox image for executing SciCode model-generated code.
#
# The scientific stack is baked in so the container needs NO network at run
# time — the SciCode generator runs each step with network_mode="none".
#
# Build once, from the sambaeval/ project root, with Podman:
#   podman build -t scicode-sandbox -f scripts/generators/scicode_sandbox.Dockerfile .
#
# If that build fails pulling the base image with a credential-helper error
# (Podman falls back to ~/.docker/config.json, which may have a credsStore /
# credHelpers entry that errors), build with an empty auth file so Podman does
# an anonymous pull and never touches the Docker config:
#   printf '{"auths":{}}' > /tmp/empty-auth.json
#   podman build --authfile /tmp/empty-auth.json -t scicode-sandbox \
#       -f scripts/generators/scicode_sandbox.Dockerfile .
#
# Override the image name the generator looks for via SCICODE_SANDBOX_IMAGE.
FROM python:3.11-slim

# Keep versions in sync with scripts/requirements.txt.
RUN pip install --no-cache-dir \
        "numpy>=2.4.6" \
        "scipy>=1.17.1" \
        "sympy>=1.14.0" \
        "h5py>=3.16.0" \
        "matplotlib>=3.9"

# Headless matplotlib so plotting code in solutions never blocks on a GUI.
ENV MPLBACKEND=Agg

WORKDIR /sandbox
