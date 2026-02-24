import { GraphEdge } from './types';

export function isCrossStackEdge(edge: GraphEdge): boolean {
  const fromStack = edge.from.split('.')[0];
  const toStack = edge.to.split('.')[0];
  return fromStack !== toStack;
}
