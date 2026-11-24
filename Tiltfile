# Kaiju dev loop (KOBE-7). `scripts/dev-cluster.sh && tilt up` builds every service image and deploys
# the Helm chart (plus a throwaway Postgres) into a k3d cluster with gVisor. To develop against a
# real k3s cluster instead, set KAIJU_DEV_CONTEXT=<kube context> and KAIJU_DEV_REGISTRY=<registry the
# cluster can pull from>. There is no docker compose.

dev_context = os.getenv("KAIJU_DEV_CONTEXT", "")
current = k8s_context()
local = current.startswith("k3d-")
if dev_context:
    allow_k8s_contexts(dev_context)
# allow_k8s_contexts only allows; pin the context so a stray `kubectl config use-context` can't
# point the dev loop at another cluster.
if not local and current != dev_context:
    fail("refusing to deploy to context %r: use a k3d-* context or set KAIJU_DEV_CONTEXT=%s" % (current, current))
dev_registry = os.getenv("KAIJU_DEV_REGISTRY", "")
if dev_registry:
    default_registry(dev_registry)
# Parallel agents each take their own namespace (kaiju-dev-<ticket>) and web port; the default
# stays kaiju-dev on :3000. Never the production namespace `kaiju`.
NAMESPACE = os.getenv("KAIJU_DEV_NAMESPACE", "kaiju-dev")
if NAMESPACE != "kaiju-dev" and not NAMESPACE.startswith("kaiju-dev-"):
    fail("KAIJU_DEV_NAMESPACE must be kaiju-dev or kaiju-dev-<suffix>, got %r" % NAMESPACE)
if local and NAMESPACE != "kaiju-dev":
    # dev/postgres.yaml and dev/values.yaml are written for kaiju-dev.
    fail("KAIJU_DEV_NAMESPACE is for shared real clusters; k3d dev uses kaiju-dev")
WEB_PORT = os.getenv("KAIJU_DEV_WEB_PORT", "3000")

update_settings(max_parallel_updates=2, k8s_upsert_timeout_secs=300)

REGISTRY = "ghcr.io/splittingatom"
# Every workspace manifest must be in each build context (pnpm --frozen-lockfile checks all
# importers); sources are limited to the service being built plus shared packages.
MANIFESTS = [
    "apps/web/package.json",
    "services/server/package.json",
    "services/sandbox-agent/package.json",
    "services/mcp-proxy/package.json",
    "services/egress-proxy/package.json",
    "services/model-gateway/package.json",
    "tools/license-check/package.json",
    "charts/kaiju/package.json",
]
COMMON = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs", "turbo.json", "tsconfig.base.json", "packages"] + MANIFESTS

def kaiju_image(name, dockerfile, sources, build_args={}):
    docker_build(
        "%s/kaiju-%s" % (REGISTRY, name),
        context=".",
        dockerfile=dockerfile,
        build_args=build_args,
        only=COMMON + sources,
        ignore=["**/node_modules", "**/dist", "**/.next", "**/*.test.ts"],
    )

kaiju_image("web", "apps/web/Dockerfile", ["apps/web"])
# The Node services share services/Dockerfile (KOBE-723).
kaiju_image("server", "services/Dockerfile", ["services/server"], {"SERVICE": "server"})
kaiju_image("mcp-proxy", "services/Dockerfile", ["services/mcp-proxy"], {"SERVICE": "mcp-proxy"})
kaiju_image("egress-proxy", "services/Dockerfile", ["services/egress-proxy"], {"SERVICE": "egress-proxy"})
kaiju_image("model-gateway", "services/Dockerfile", ["services/model-gateway"], {"SERVICE": "model-gateway"})

if local:
    # Throwaway Postgres with public dev credentials: k3d only.
    k8s_yaml("dev/postgres.yaml")
    k8s_resource(workload="pg", labels=["deps"])
    # SMTP sink for invitations and password resets; read them at http://localhost:8025.
    k8s_yaml("dev/mailpit.yaml")
    k8s_resource(workload="mailpit", labels=["deps"], port_forwards=["8025:8025"])
    # S3-compatible object storage (SeaweedFS, Apache-2.0) for workspace sync: k3d only.
    k8s_yaml("dev/s3.yaml")
    k8s_resource(workload="s3", labels=["deps"])
    values = ["dev/values.yaml"]
    deps = ["pg", "s3"]
else:
    # Real cluster: bring your own values (database, S3, ingress) in KAIJU_DEV_VALUES.
    values_file = os.getenv("KAIJU_DEV_VALUES", "")
    if not values_file:
        fail("set KAIJU_DEV_VALUES to a values file for context %r (dev/values.yaml is k3d-only)" % current)
    values = [values_file]
    deps = []

k8s_yaml(helm("charts/kobe", name="kaiju", namespace=NAMESPACE, values=values))

for name in ["web", "server", "scheduler", "mcp-proxy", "egress-proxy", "model-gateway", "bifrost"]:
    k8s_resource(workload="kaiju-" + name, labels=["kaiju"], resource_deps=deps if name in ["server", "scheduler"] else [])
k8s_resource(workload="kaiju-migrate", labels=["kaiju"], resource_deps=deps)
k8s_resource(workload="kaiju-isolation-preflight", labels=["kaiju"])
k8s_resource(workload="kaiju-web", port_forwards=["%s:8080" % WEB_PORT])
