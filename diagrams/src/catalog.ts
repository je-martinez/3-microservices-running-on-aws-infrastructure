import type { ArchitectureData, DependencyData, FlowData } from "./schema";
import { architectureEntries } from "./data/architecture.catalog";
import { systemContextEntries } from "./data/system-context.catalog";
import { milestoneEntries } from "./data/milestones.catalog";
import { initialFlowEntries } from "./data/flows-initial.catalog";
import { authFlowEntries } from "./data/flows-auth.catalog";
import { shoppingFlowEntries } from "./data/flows-shopping.catalog";
import { eventsFlowEntries } from "./data/flows-events.catalog";
import { opsFlowEntries } from "./data/flows-ops.catalog";

type Base = {
  id: string;
  title: string;
  /** Repo-relative path WITHOUT extension; render.ts appends .gif / .png. */
  output: string;
  /** Repo-relative path of the data module this entry renders; an implicit drift watch. */
  source: string;
  /** Repo-relative globs whose change may make this diagram stale. */
  watches: string[];
  /** false → PNG only (DependencyGraph). Default true. */
  animated?: boolean;
};

export type CatalogEntry =
  | (Base & { primitive: "architecture"; data: ArchitectureData })
  | (Base & { primitive: "flow"; data: FlowData })
  | (Base & { primitive: "dependency"; data: DependencyData });

// CONTRACT: entries live in src/data/*.catalog.ts, one file per group, so groups can be edited independently. Order here is the Studio sidebar order.
export const catalog: CatalogEntry[] = [...architectureEntries, ...systemContextEntries, ...milestoneEntries, ...initialFlowEntries, ...authFlowEntries, ...shoppingFlowEntries, ...eventsFlowEntries, ...opsFlowEntries];
