import type { PiNativeCatalogModel, PiNativeSidecarManifest } from "./manifest.js";
import { decodePiNativeSidecarManifest } from "./manifest.js";

export interface FrozenPiNativeCatalog {
  readonly digest: PiNativeSidecarManifest["catalog"]["digest"];
  readonly discovery: "disabled";
  list(): readonly [PiNativeCatalogModel];
  get(providerId: string, modelId: string): PiNativeCatalogModel | undefined;
  require(providerId: string, modelId: string): PiNativeCatalogModel;
}

export function createFrozenPiNativeCatalog(
  input: unknown,
): FrozenPiNativeCatalog {
  const manifest = decodePiNativeSidecarManifest(input);
  const model = manifest.catalog.model;
  const catalog: FrozenPiNativeCatalog = {
    digest: manifest.catalog.digest,
    discovery: "disabled",
    list(): readonly [PiNativeCatalogModel] {
      return Object.freeze([model]);
    },
    get(providerId, modelId): PiNativeCatalogModel | undefined {
      return providerId === model.providerId && modelId === model.id
        ? model
        : undefined;
    },
    require(providerId, modelId): PiNativeCatalogModel {
      const selected = this.get(providerId, modelId);
      if (selected === undefined) {
        throw new Error("Pi native model is outside the frozen sidecar catalog");
      }
      return selected;
    },
  };
  return Object.freeze(catalog);
}
