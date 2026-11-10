/**
 * Reading a performer image's OCI labels straight from the registry, without pulling it.
 *
 * The point is the *without pulling*. `check-performer.ts` reads the same labels via
 * `docker image inspect`, which is cheaper and better once you have the image — but it can
 * only answer about an image you have already spent ~1GB fetching. This answers "which commit
 * is behind `:main` right now?" in three small HTTP requests: a token, the manifest, and the
 * config blob that carries the labels.
 *
 * Written for FIT/PERF scheduling, which needed the revision *before* deciding what to run.
 * That scheduler is gone, so nothing calls this today — it is kept because the capability is
 * general (any floating tag, any performer) and the awkward parts are already solved here.
 */
import { sdkPerformerImageBasename, type Sdk } from "../../../util/sdk/sdks.js";
import { GHCR_REGISTRY } from "./performer-image.js";

/** Media types a manifest request should accept, covering both single images and multi-arch indexes. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

interface Manifest {
  config?: { digest?: string };
  manifests?: { digest?: string; platform?: { architecture?: string; os?: string } }[];
}

interface ImageConfigBlob {
  config?: { Labels?: Record<string, string> };
}

export interface ImageLabelOptions {
  /** A GitHub token with `read:packages`; ghcr accepts it as the registry password. */
  token: string;
  owner?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Exchange a GitHub token for a registry pull token.
 *
 * ghcr's `/token` endpoint wants **Basic** auth — the PAT as the password, with any username —
 * which is what `docker login` sends. A bearer of the same token, raw or base64, is rejected
 * with a 401 or 403, so this is worth stating rather than rediscovering.
 */
export async function registryPullToken(repository: string, options: ImageLabelOptions): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `https://${GHCR_REGISTRY}/token?service=${GHCR_REGISTRY}&scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
  const response = await doFetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`x:${options.token}`).toString("base64")}` },
  });
  if (!response.ok) {
    throw new Error(`Could not get a registry token for ${repository}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error(`Registry token response for ${repository} carried no token`);
  }
  return body.token;
}

/**
 * The OCI labels on `<owner>/<sdk>-fit-performer:<tag>`.
 *
 * Returns undefined rather than throwing when the image or its labels can't be read — an
 * unreadable image should cost the caller its knowledge of that one build, not the whole
 * operation. But it warns on the way past, because a credentials problem here otherwise reads
 * downstream as "this build declares no revision", which looks like a data problem rather than
 * an auth one.
 */
export async function fetchPerformerImageLabels(sdk: Sdk, tag: string, options: ImageLabelOptions): Promise<Record<string, string> | undefined> {
  const owner = options.owner ?? "couchbase";
  const repository = `${owner}/${sdkPerformerImageBasename(sdk)}-fit-performer`;
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const token = await registryPullToken(repository, options);
    const headers = { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT };

    const manifestResponse = await doFetch(`https://${GHCR_REGISTRY}/v2/${repository}/manifests/${tag}`, { headers });
    if (!manifestResponse.ok) {
      console.warn(`  ! could not read ${repository}:${tag} manifest (HTTP ${manifestResponse.status})`);
      return undefined;
    }
    let manifest = (await manifestResponse.json()) as Manifest;

    // A multi-arch index doesn't carry a config of its own; follow it to a real manifest.
    // Any architecture will do — the labels are build metadata, identical across them.
    if (!manifest.config?.digest && manifest.manifests && manifest.manifests.length > 0) {
      const preferred = manifest.manifests.find((entry) => entry.platform?.os === "linux") ?? manifest.manifests[0];
      if (!preferred.digest) {
        return undefined;
      }
      const inner = await doFetch(`https://${GHCR_REGISTRY}/v2/${repository}/manifests/${preferred.digest}`, { headers });
      if (!inner.ok) {
        return undefined;
      }
      manifest = (await inner.json()) as Manifest;
    }

    const digest = manifest.config?.digest;
    if (!digest) {
      return undefined;
    }
    const blobResponse = await doFetch(`https://${GHCR_REGISTRY}/v2/${repository}/blobs/${digest}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!blobResponse.ok) {
      return undefined;
    }
    const blob = (await blobResponse.json()) as ImageConfigBlob;
    return blob.config?.Labels;
  } catch (err) {
    console.warn(`  ! could not read labels for ${repository}:${tag}: ${(err as Error).message}`);
    return undefined;
  }
}

/** The OCI/Couchbase labels worth keeping, and what to call them once reduced. */
const LABEL_TO_FIELD: Record<string, string> = {
  "org.opencontainers.image.created": "created",
  "org.opencontainers.image.revision": "revision",
  "org.opencontainers.image.source": "source",
  "com.couchbase.pr": "pr",
  "com.couchbase.github.actions.run": "ciRun",
};

/** Reduce raw labels to the `image` block a perf run records under `impl`. */
export function imageBlockFromLabels(labels: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!labels) {
    return undefined;
  }
  const image: Record<string, string> = {};
  for (const [label, field] of Object.entries(LABEL_TO_FIELD)) {
    const value = labels[label];
    if (value) {
      image[field] = value;
    }
  }
  return Object.keys(image).length > 0 ? image : undefined;
}
