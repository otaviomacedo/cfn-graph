import { GraphNode, GraphEdge, EdgeType } from './types';

export class CloudFormationGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private exports: Map<string, string> = new Map(); // exportName -> nodeId

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.edges = this.edges.filter(edge => edge.from !== id && edge.to !== id);
    
    // Remove from exports if it's an export node
    for (const [exportName, nodeId] of this.exports.entries()) {
      if (nodeId === id) {
        this.exports.delete(exportName);
      }
    }
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
    return this.edges.filter(edge => edge.crossStack);
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

  registerExport(exportName: string, nodeId: string): void {
    this.exports.set(exportName, nodeId);
  }

  getExportNode(exportName: string): string | undefined {
    return this.exports.get(exportName);
  }

  getExports(): Map<string, string> {
    return new Map(this.exports);
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

  moveNode(currentId: string, newStackId: string, newLogicalId: string): void {
    const node = this.nodes.get(currentId);
    if (!node) {
      throw new Error(`Node ${currentId} does not exist`);
    }

    const currentStackId = node.stackId;
    const newQualifiedId = this.getQualifiedId(newStackId, newLogicalId);
    
    // Check if target location already exists
    if (newQualifiedId !== currentId && this.nodes.has(newQualifiedId)) {
      throw new Error(`Target location ${newQualifiedId} already exists`);
    }

    // If the ID is the same, no move needed
    if (currentId === newQualifiedId) {
      return;
    }

    const isMovingAcrossStacks = currentStackId !== newStackId;

    // Create new node with updated location
    const movedNode: GraphNode = {
      ...node,
      id: newQualifiedId,
      stackId: newStackId
    };

    // Track edges that need to be converted to cross-stack references
    const edgesToConvert: Array<{ edge: GraphEdge; targetNode: GraphNode }> = [];

    // Update edges to point to new ID
    const updatedEdges: GraphEdge[] = [];
    for (const edge of this.edges) {
      const updatedEdge = { ...edge };
      
      if (edge.from === currentId) {
        updatedEdge.from = newQualifiedId;
        
        // Check if this edge needs to become a cross-stack reference
        const toNode = this.nodes.get(edge.to);
        if (toNode && isMovingAcrossStacks) {
          if (toNode.stackId !== newStackId && edge.type === EdgeType.REFERENCE) {
            // This in-stack reference needs to become a cross-stack import
            edgesToConvert.push({ edge: updatedEdge, targetNode: toNode });
          }
          updatedEdge.crossStack = toNode.stackId !== newStackId;
        }
      }
      
      if (edge.to === currentId) {
        updatedEdge.to = newQualifiedId;
        
        // Update crossStack flag if moving between stacks
        const fromNode = this.nodes.get(edge.from);
        if (fromNode && isMovingAcrossStacks) {
          updatedEdge.crossStack = fromNode.stackId !== newStackId;
        }
      }
      
      updatedEdges.push(updatedEdge);
    }

    // Update exports if this node is exported
    const exportsToUpdate: Array<[string, string]> = [];
    for (const [exportName, nodeId] of this.exports.entries()) {
      if (nodeId === currentId) {
        exportsToUpdate.push([exportName, newQualifiedId]);
      }
    }

    // Apply all changes
    this.nodes.delete(currentId);
    this.nodes.set(newQualifiedId, movedNode);
    this.edges = updatedEdges;
    
    for (const [exportName, nodeId] of exportsToUpdate) {
      this.exports.set(exportName, nodeId);
    }

    // Convert in-stack references to cross-stack imports
    if (isMovingAcrossStacks && edgesToConvert.length > 0) {
      this.convertReferencesToImports(newQualifiedId, edgesToConvert);
    }
  }

  private convertReferencesToImports(
    movedNodeId: string, 
    edgesToConvert: Array<{ edge: GraphEdge; targetNode: GraphNode }>
  ): void {
    for (const { edge, targetNode } of edgesToConvert) {
      // Check if an export already exists for this target
      let exportName: string | undefined;
      let exportNodeId: string | undefined;

      for (const [name, nodeId] of this.exports.entries()) {
        // Check if this export points to the target node
        const exportNode = this.nodes.get(nodeId);
        if (exportNode && exportNode.type === 'AWS::CloudFormation::Export') {
          const exportEdges = this.edges.filter(
            e => e.from === nodeId && e.to === targetNode.id && e.type === EdgeType.EXPORT
          );
          if (exportEdges.length > 0) {
            exportName = name;
            exportNodeId = nodeId;
            break;
          }
        }
      }

      // If no export exists, create one
      if (!exportName || !exportNodeId) {
        const targetLogicalId = this.getLogicalId(targetNode.id);
        exportName = `${targetNode.stackId}-${targetLogicalId}`;
        exportNodeId = this.getQualifiedId(targetNode.stackId!, `Export.${targetLogicalId}`);

        // Create export node
        const exportNode: GraphNode = {
          id: exportNodeId,
          type: 'AWS::CloudFormation::Export',
          properties: {
            Name: exportName,
            Value: { Ref: targetLogicalId }
          },
          stackId: targetNode.stackId
        };

        this.nodes.set(exportNodeId, exportNode);
        this.exports.set(exportName, exportNodeId);

        // Link export to target resource
        this.edges.push({
          from: exportNodeId,
          to: targetNode.id,
          type: EdgeType.EXPORT
        });
      }

      // Update the edge to point to the export and change type to IMPORT_VALUE
      const edgeIndex = this.edges.findIndex(
        e => e.from === edge.from && e.to === edge.to && e.type === edge.type
      );
      
      if (edgeIndex !== -1) {
        this.edges[edgeIndex] = {
          from: movedNodeId,
          to: exportNodeId,
          type: EdgeType.IMPORT_VALUE,
          crossStack: true
        };
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
    
    for (const [exportName, nodeId] of this.exports.entries()) {
      reversed.exports.set(exportName, nodeId);
    }
    
    return reversed;
  }
}
