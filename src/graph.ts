import { GraphNode, GraphEdge, EdgeType, NodeLocation } from './types';
import { isCrossStackEdge } from './utils';

export class CloudFormationGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.edges = this.edges.filter(edge => edge.from !== id && edge.to !== id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getNodesByStack(stackId: string): GraphNode[] {
    return Array.from(this.nodes.values()).filter(node => node.stackId === stackId);
  }

  addEdge(edge: GraphEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
      throw new Error(`Cannot add edge: nodes ${edge.from} or ${edge.to} do not exist`);
    }
    this.edges.push(edge);
  }

  removeEdge(from: string, to: string): void {
    this.edges = this.edges.filter(edge => !(edge.from === from && edge.to === to));
  }

  getEdges(nodeId?: string): GraphEdge[] {
    if (!nodeId) return [...this.edges];
    return this.edges.filter(edge => edge.from === nodeId || edge.to === nodeId);
  }

  getCrossStackEdges(): GraphEdge[] {
    return this.edges.filter(edge => isCrossStackEdge(edge));
  }

  getDependencies(nodeId: string): string[] {
    return this.edges
      .filter(edge => edge.from === nodeId)
      .map(edge => edge.to);
  }

  getDependents(nodeId: string): string[] {
    return this.edges
      .filter(edge => edge.to === nodeId)
      .map(edge => edge.from);
  }



  getAllStacks(): string[] {
    const stacks = new Set<string>();
    for (const node of this.nodes.values()) {
      if (node.stackId) {
        stacks.add(node.stackId);
      }
    }
    return Array.from(stacks);
  }

  moveNode(from: NodeLocation, to: NodeLocation): void {
    const currentId = this.getQualifiedId(from.stackId, from.logicalId);
    const node = this.nodes.get(currentId);
    if (!node) {
      throw new Error(`Node ${currentId} does not exist`);
    }

    const newQualifiedId = this.getQualifiedId(to.stackId, to.logicalId);
    
    // Check if target location already exists
    if (newQualifiedId !== currentId && this.nodes.has(newQualifiedId)) {
      throw new Error(`Target location ${newQualifiedId} already exists`);
    }

    // If the ID is the same, no move needed
    if (currentId === newQualifiedId) {
      return;
    }

    const isMovingAcrossStacks = from.stackId !== to.stackId;
    const oldLogicalId = from.logicalId;
    const newLogicalId = to.logicalId;

    // Create new node with updated location
    const movedNode: GraphNode = {
      ...node,
      id: newQualifiedId,
      stackId: to.stackId
    };

    // Track edges that need to be converted to cross-stack references
    const edgesToConvert: Array<{ edge: GraphEdge; targetNode: GraphNode; targetStackId: string }> = [];
    const updatedEdges: GraphEdge[] = [];
    const edgesToRestore: GraphEdge[] = [];
    
    for (const edge of this.edges) {
      const updatedEdge = { ...edge };
      let shouldKeepEdge = true;
      
      if (edge.from === currentId) {
        updatedEdge.from = newQualifiedId;
        
        const toNode = this.nodes.get(edge.to);
        if (toNode && isMovingAcrossStacks) {
          if (toNode.stackId !== to.stackId) {
            // Moving to different stack than target - convert to cross-stack
            if (edge.type === EdgeType.DEPENDS_ON) {
              shouldKeepEdge = false;
            } else if (edge.type === EdgeType.REFERENCE || edge.type === EdgeType.GET_ATT) {
              edgesToConvert.push({ edge: updatedEdge, targetNode: toNode, targetStackId: toNode.stackId! });
              if (edge.attribute) {
                updatedEdge.attribute = edge.attribute;
              }
            }
          } else {
            // Moving to same stack as target - convert back to in-stack reference
            if (edge.attribute) {
              updatedEdge.type = EdgeType.GET_ATT;
            } else {
              updatedEdge.type = EdgeType.REFERENCE;
            }
            updatedEdge.exportName = undefined;
            edgesToRestore.push({ from: newQualifiedId, to: edge.to, type: EdgeType.DEPENDS_ON });
            if (edge.type === EdgeType.REFERENCE || edge.type === EdgeType.GET_ATT) {
              edgesToRestore.push({ from: newQualifiedId, to: edge.to, type: EdgeType.DEPENDS_ON });
            }
          }
        }
      }
      
      if (edge.to === currentId) {
        updatedEdge.to = newQualifiedId;
        
        const fromNode = this.nodes.get(edge.from);
        if (fromNode && isMovingAcrossStacks) {
          if (fromNode.stackId !== to.stackId) {
            // Target moving to different stack - convert to cross-stack
            if (edge.type === EdgeType.DEPENDS_ON) {
              shouldKeepEdge = false;
            } else if (edge.type === EdgeType.REFERENCE || edge.type === EdgeType.GET_ATT) {
              // When the target moves, create export in the NEW stack (where target is moving to)
              const targetEdge = { ...edge, to: newQualifiedId };
              edgesToConvert.push({ edge: targetEdge, targetNode: movedNode, targetStackId: to.stackId });
              if (edge.attribute) {
                updatedEdge.attribute = edge.attribute;
              }
            }
          } else {
            // Target moving to same stack - convert back to in-stack reference  
            if (edge.attribute) {
              updatedEdge.type = EdgeType.GET_ATT;
            } else {
              updatedEdge.type = EdgeType.REFERENCE;
            }
            updatedEdge.exportName = undefined;
            if (edge.type === EdgeType.REFERENCE || edge.type === EdgeType.GET_ATT) {
              edgesToRestore.push({ from: edge.from, to: newQualifiedId, type: EdgeType.DEPENDS_ON });
            }
          }
        }
      }
      
      if (shouldKeepEdge) {
        updatedEdges.push(updatedEdge);
      }
    }

    if (!isMovingAcrossStacks && oldLogicalId !== newLogicalId) {
      for (const [nodeId, n] of this.nodes.entries()) {
        if (nodeId !== currentId && n.stackId === from.stackId) {
          n.properties = this.updateReferencesInProperties(n.properties, oldLogicalId, newLogicalId);
        }
      }
    }

    this.nodes.delete(currentId);
    this.nodes.set(newQualifiedId, movedNode);
    this.edges = updatedEdges;

    for (const edge of edgesToRestore) {
      if (!this.edges.some(e => e.from === edge.from && e.to === edge.to && e.type === EdgeType.DEPENDS_ON)) {
        this.edges.push(edge);
      }
    }

    if (isMovingAcrossStacks && edgesToConvert.length > 0) {
      this.convertReferencesToImports(edgesToConvert);
    }
  }

  private updateReferencesInProperties(
    obj: any,
    oldLogicalId: string,
    newLogicalId: string
  ): any {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.updateReferencesInProperties(item, oldLogicalId, newLogicalId));
    }

    // Update Ref intrinsic
    if (obj.Ref === oldLogicalId) {
      return { Ref: newLogicalId };
    }

    // Update Fn::GetAtt intrinsic
    if (obj['Fn::GetAtt']) {
      const attr = obj['Fn::GetAtt'];
      if (Array.isArray(attr) && attr[0] === oldLogicalId) {
        return { 'Fn::GetAtt': [newLogicalId, ...attr.slice(1)] };
      }
    }

    // Recursively process object properties
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.updateReferencesInProperties(value, oldLogicalId, newLogicalId);
    }
    return result;
  }

  private convertReferencesToImports(
    edgesToConvert: Array<{ edge: GraphEdge; targetNode: GraphNode; targetStackId: string }>
  ): void {
    for (const { edge, targetNode, targetStackId } of edgesToConvert) {
      const targetLogicalId = this.getLogicalId(targetNode.id);
      const attribute = edge.attribute;
      
      // Check if an export name already exists on any edge pointing to this target
      let existingExportName: string | undefined;
      for (const e of this.edges) {
        if (e.to === targetNode.id && e.exportName && (e.type === EdgeType.REFERENCE || e.type === EdgeType.GET_ATT)) {
          if (attribute && e.attribute === attribute) {
            existingExportName = e.exportName;
            break;
          } else if (!attribute && !e.attribute) {
            existingExportName = e.exportName;
            break;
          }
        }
      }
      
      if (!existingExportName) {
        const outputId = attribute ? `${targetLogicalId}${attribute}` : targetLogicalId;
        existingExportName = `${targetStackId}-${outputId}`;
      }
      
      // Update the edge with the export name
      const edgeToUpdate = this.edges.find(e => e.from === edge.from && e.to === edge.to && (e.type === EdgeType.REFERENCE || e.type === EdgeType.GET_ATT));
      if (edgeToUpdate) {
        edgeToUpdate.exportName = existingExportName;
      }
    }
  }

  private getQualifiedId(stackId: string, logicalId: string): string {
    return `${stackId}.${logicalId}`;
  }

  getStackId(qualifiedId: string): string | undefined {
    const node = this.nodes.get(qualifiedId);
    return node?.stackId;
  }

  getLogicalId(qualifiedId: string): string {
    const parts = qualifiedId.split('.');
    return parts.length > 1 ? parts.slice(1).join('.') : qualifiedId;
  }

  /**
   * Returns all nodes in topologically sorted order based on their dependencies.
   * If a circular dependency is detected, an error is thrown.
   */
  getAllNodesSorted(): GraphNode[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const result: string[] = [];

    const visit = (nodeId: string): void => {
      if (temp.has(nodeId)) {
        throw new Error('Circular dependency detected');
      }
      if (visited.has(nodeId)) return;

      temp.add(nodeId);
      const deps = this.getDependencies(nodeId);
      for (const dep of deps) {
        visit(dep);
      }
      temp.delete(nodeId);
      visited.add(nodeId);
      result.push(nodeId);
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        visit(nodeId);
      }
    }

    return result.map(id => this.nodes.get(id)!);
  }

  /**
   * Returns a copy of this graph with all edge directions reversed.
   */
  opposite(): CloudFormationGraph {
    const reversed = new CloudFormationGraph();

    reversed.nodes = this.nodes;

    for (const edge of this.edges) {
      reversed.edges.push({ ...edge, from: edge.to, to: edge.from });
    }
    
    return reversed;
  }
}
