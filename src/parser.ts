import { CloudFormationTemplate, Resource, GraphNode, GraphEdge, EdgeType, StackTemplate, Output } from './types';
import { CloudFormationGraph } from './graph';

export class CloudFormationParser {
  parse(template: CloudFormationTemplate, stackId: string = 'default'): CloudFormationGraph {
    const graph = new CloudFormationGraph();

    // Add nodes for each resource
    for (const [resourceId, resource] of Object.entries(template.Resources)) {
      const node: GraphNode = {
        id: this.getQualifiedId(stackId, resourceId),
        type: resource.Type,
        properties: resource.Properties || {},
        metadata: {
          ...resource.Metadata,
          ...(resource.CreationPolicy && { CreationPolicy: resource.CreationPolicy }),
          ...(resource.DeletionPolicy && { DeletionPolicy: resource.DeletionPolicy }),
          ...(resource.UpdatePolicy && { UpdatePolicy: resource.UpdatePolicy }),
          ...(resource.UpdateReplacePolicy && { UpdateReplacePolicy: resource.UpdateReplacePolicy })
        },
        stackId
      };
      graph.addNode(node);
    }

    // Add nodes for exports
    if (template.Outputs) {
      for (const [outputId, output] of Object.entries(template.Outputs)) {
        if (output.Export) {
          const exportName = this.resolveExportName(output.Export.Name);
          const node: GraphNode = {
            id: this.getQualifiedId(stackId, `Export.${outputId}`),
            type: 'AWS::CloudFormation::Export',
            properties: {
              Name: exportName,
              Value: output.Value
            },
            stackId
          };
          graph.addNode(node);
          graph.registerExport(exportName, node.id);
        }
      }
    }

    // Add edges for dependencies
    for (const [resourceId, resource] of Object.entries(template.Resources)) {
      const qualifiedId = this.getQualifiedId(stackId, resourceId);
      this.extractDependencies(qualifiedId, resource, graph, stackId);
      this.extractReferences(qualifiedId, resource, graph, stackId);
      this.extractImports(qualifiedId, resource, graph);
    }

    // Link exports to their source resources
    if (template.Outputs) {
      for (const [outputId, output] of Object.entries(template.Outputs)) {
        if (output.Export) {
          const exportNodeId = this.getQualifiedId(stackId, `Export.${outputId}`);
          const sourceRefs = this.findReferences(output.Value);
          for (const ref of sourceRefs) {
            const sourceId = this.getQualifiedId(stackId, ref);
            if (graph.getNode(sourceId)) {
              graph.addEdge({
                from: exportNodeId,
                to: sourceId,
                type: EdgeType.EXPORT
              });
            }
          }
        }
      }
    }

    return graph;
  }

  parseMultiple(stacks: StackTemplate[]): CloudFormationGraph {
    const graph = new CloudFormationGraph();

    // First pass: parse each template independently
    for (const { stackId, template } of stacks) {
      const stackGraph = this.parse(template, stackId);
      
      // Merge nodes
      for (const node of stackGraph.getAllNodes()) {
        graph.addNode(node);
      }

      // Merge edges
      for (const edge of stackGraph.getEdges()) {
        graph.addEdge(edge);
      }

      // Merge exports
      for (const [exportName, nodeId] of stackGraph.getExports()) {
        graph.registerExport(exportName, nodeId);
      }
    }

    // Second pass: resolve cross-stack imports
    for (const node of graph.getAllNodes()) {
      if (node.type !== 'AWS::CloudFormation::Export') {
        const imports = this.findImports(node.properties);
        for (const importName of imports) {
          const exportNodeId = graph.getExportNode(importName);
          if (exportNodeId) {
            graph.addEdge({
              from: node.id,
              to: exportNodeId,
              type: EdgeType.IMPORT_VALUE,
              crossStack: true
            });
          }
        }
      }
    }

    return graph;
  }

  private getQualifiedId(stackId: string, resourceId: string): string {
    return `${stackId}.${resourceId}`;
  }

  private resolveExportName(name: any): string {
    if (typeof name === 'string') return name;
    if (name.Ref) return name.Ref;
    if (name['Fn::Sub']) return name['Fn::Sub'];
    return JSON.stringify(name);
  }

  private extractDependencies(resourceId: string, resource: Resource, graph: CloudFormationGraph, stackId: string): void {
    if (!resource.DependsOn) return;

    const dependencies = Array.isArray(resource.DependsOn) 
      ? resource.DependsOn 
      : [resource.DependsOn];

    for (const dep of dependencies) {
      const qualifiedDep = this.getQualifiedId(stackId, dep);
      graph.addEdge({
        from: resourceId,
        to: qualifiedDep,
        type: EdgeType.DEPENDS_ON
      });
    }
  }

  private extractReferences(resourceId: string, resource: Resource, graph: CloudFormationGraph, stackId: string): void {
    if (!resource.Properties) return;

    const refs = this.findReferences(resource.Properties);
    for (const ref of refs) {
      const qualifiedRef = this.getQualifiedId(stackId, ref);
      if (graph.getNode(qualifiedRef)) {
        graph.addEdge({
          from: resourceId,
          to: qualifiedRef,
          type: EdgeType.REFERENCE
        });
      }
    }
  }

  private extractImports(resourceId: string, resource: Resource, graph: CloudFormationGraph): void {
    if (!resource.Properties) return;

    const imports = this.findImports(resource.Properties);
    for (const importName of imports) {
      const exportNodeId = graph.getExportNode(importName);
      if (exportNodeId) {
        graph.addEdge({
          from: resourceId,
          to: exportNodeId,
          type: EdgeType.IMPORT_VALUE,
          crossStack: true
        });
      }
    }
  }

  private findReferences(obj: any, refs: Set<string> = new Set()): string[] {
    if (typeof obj !== 'object' || obj === null) return Array.from(refs);

    if (obj.Ref && typeof obj.Ref === 'string') {
      refs.add(obj.Ref);
    }

    if (obj['Fn::GetAtt']) {
      const target = Array.isArray(obj['Fn::GetAtt']) 
        ? obj['Fn::GetAtt'][0] 
        : obj['Fn::GetAtt'];
      if (typeof target === 'string') {
        refs.add(target);
      }
    }

    for (const value of Object.values(obj)) {
      this.findReferences(value, refs);
    }

    return Array.from(refs);
  }

  private findImports(obj: any, imports: Set<string> = new Set()): string[] {
    if (typeof obj !== 'object' || obj === null) return Array.from(imports);

    if (obj['Fn::ImportValue']) {
      const importValue = obj['Fn::ImportValue'];
      if (typeof importValue === 'string') {
        imports.add(importValue);
      } else if (typeof importValue === 'object') {
        // Handle complex import values like Fn::Sub
        const resolved = this.resolveExportName(importValue);
        imports.add(resolved);
      }
    }

    for (const value of Object.values(obj)) {
      this.findImports(value, imports);
    }

    return Array.from(imports);
  }
}
