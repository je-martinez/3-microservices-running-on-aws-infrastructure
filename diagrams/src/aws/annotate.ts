import { badgeCentres } from "./badges";
import { headerBands } from "./header";
import { placeLabels } from "./labels";
import type { DiagramLayout, Point, Rect } from "./layout";
import type { AwsDiagramData } from "./schema";

export type Annotations = { badges: Point[]; labels: Record<string, Rect> };

/**
 * Step badges, then edge labels, for a laid-out diagram. Placement never breaks a hard rule (badges and labels
 * off nodes, group headers and each other): when no spot qualifies it throws, naming the diagram.
 */
export function annotate(id: string, data: AwsDiagramData, layout: DiagramLayout): Annotations {
  const headers = headerBands(data, layout);
  // WHY: badges keep off ELK's reserved label spots, so most labels can stay where ELK made room for them.
  const elkLabels = Object.values(layout.edges).flatMap((r) => (r.label ? [r.label] : []));
  try {
    const loops = new Set(data.edges.filter((e) => e.from === e.to).map((e) => e.id));
    const badges = badgeCentres(data.steps, layout.edges, Object.values(layout.groups), [...Object.values(layout.nodes), ...headers], elkLabels, loops);
    return { badges, labels: placeLabels(data, layout, badges) };
  } catch (err) {
    throw new Error(`diagram "${id}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
