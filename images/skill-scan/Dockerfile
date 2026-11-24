# Kaiju's external skill scanner image (KOBE-341, spec SK32): Cisco skill-scanner (Apache-2.0) and
# Kaiju's runner, which scans one catalog package (mounted read-only under /input in parts) with
# the scanner's offline analyzers and prints one result line. No network, no secrets: the Job
# that runs it has no service account token, no Secret, no DNS and a deny-all NetworkPolicy.
# Build from the repository root: docker build -f images/skill-scan/Dockerfile .
# Every input is pinned (base digest, the release's hashed lock, the release wheel's hashes).
# No `# syntax=` directive (see images/sandbox/Dockerfile for why).
# A newer digest than the other images' (2026-10-06: libpcre2 10.46-1~deb13u3, review-341 L6).
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

FROM ${PYTHON_IMAGE}
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/kaiju/skill-scan \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/home/.cache \
    PYTHON_DOTENV_DISABLED=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    HF_HUB_OFFLINE=1 \
    DO_NOT_TRACK=1

# Dependencies from the scanner's hashed lock (no resolver, no extras, without pcodedmp: see the
# lock's header), then the scanner's own wheel.
# pip, setuptools and wheel are removed afterwards: nothing installs at runtime. Bytecode is
# compiled now because the root is read-only (olefile's Python 2 module, never imported, excepted).
COPY images/skill-scan/requirements.txt /tmp/requirements.txt
COPY images/skill-scan/scanner-requirements.txt /tmp/scanner-requirements.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements.txt \
 && pip install --require-hashes --no-deps -r /tmp/scanner-requirements.txt \
 && rm /tmp/requirements.txt /tmp/scanner-requirements.txt \
 && python -m compileall -q -x 'olefile/olefile2\.py$' /usr/local/lib/python3.12/site-packages \
 && pip uninstall -y pip setuptools wheel

# Kaiju's runner: root-owned and read-only.
COPY images/skill-scan/kaiju_skill_scan /opt/kaiju/skill-scan/kaiju_skill_scan

# User 1000:1000 (numeric, for runAsNonRoot). /input holds the package parts (ConfigMaps). No setuid
# or setgid bits; the package managers are removed (/var/lib/dpkg/status stays for Trivy).
# ca-certificates from trixie's updates: the base's 20250419 still trusts emSign ECC Root CA - G3
# (compromised intermediates, KOBE-486); Python's ssl and aiohttp read this store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 kobe \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin kobe \
 && mkdir -p /input \
 && chown -R 0:0 /opt/kaiju \
 && chmod -R a-w,a+rX /opt/kaiju \
 && python -m compileall -q /opt/kaiju/skill-scan \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && rm -rf /usr/bin/apt* /usr/bin/dpkg* /usr/sbin/dpkg* /usr/lib/apt /var/cache/apt /var/lib/apt

# Kaiju's license, NOTICE and third-party inventory (Apache-2.0 section 4, KOBE-375).
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md /usr/share/doc/kaiju/
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python", "-m", "kaiju_skill_scan"]
CMD ["--parts", "/input"]
