# OTC container

`Containerfile` builds the sandbox image. `ARG NODE_BASE` is declared before
the first `FROM` so the build argument is in scope for the base reference. Both
floating inputs are explicit:

```sh
podman build \
  --build-arg NODE_BASE=docker.io/library/node:26.13.0-slim \
  --build-arg OPENCODE_VERSION=2.2.6 \
  --build-arg HOST_UID="$(id -u)" \
  --build-arg HOST_GID="$(id -g)" \
  -t localhost/otc-sandbox:2.2.6 .
```

`otc freeze` resolves the tag to an immutable image ID and proves the image
contains the declared OpenCode version. Campaigns then dispatch the ID, never
a mutable tag.

## Isolation, stated honestly

The container has a read-only root filesystem, a bounded `/tmp` tmpfs, dropped
capabilities, no-new-privileges and `--userns=keep-id`. Only the trial
workspace, the read-only config home and the read-only subject payload are
mounted.

It shares the host network when `runtime.network` is `host`, because the
existing provider route lives on the host loopback proxy. That is **not**
provider-only egress and OTC does not claim it is. Use `network: "none"` when
the trial needs no provider, or add network enforcement before claiming a
provider-only boundary.
