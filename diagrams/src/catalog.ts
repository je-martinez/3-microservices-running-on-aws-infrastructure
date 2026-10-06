import type { ArchitectureData, DependencyData, FlowData } from "./schema";

type Base = {
  id: string;
  title: string;
  /** Repo-relative path WITHOUT extension; render.ts appends .gif / .png. */
  output: string;
  /** Repo-relative globs whose change may make this diagram stale. */
  watches: string[];
  /** false → PNG only (DependencyGraph). Default true. */
  animated?: boolean;
};

export type CatalogEntry =
  | (Base & { primitive: "architecture"; data: ArchitectureData })
  | (Base & { primitive: "flow"; data: FlowData })
  | (Base & { primitive: "dependency"; data: DependencyData });

export const catalog: CatalogEntry[] = [];
